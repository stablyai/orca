import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { runProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readReleaseMacBuildWorkflowOptions } from './run-release-mac-build-workflow.mjs'

const { jobs } = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const { steps } = jobs.build
const gate = steps.find((step) => step.id === 'mac-signing-gate')
const submissions = steps.filter((step) =>
  step.uses?.startsWith('signpath/github-action-submit-signing-request@')
)

function signingAllowed(submission, outcome, attempt = 1, platform = 'win', uploads = {}) {
  const expression = submission.if.replace(/steps\.([a-z][a-z0-9-]*)/g, 'steps["$1"]')
  return runInNewContext(expression, {
    matrix: { platform },
    github: { run_attempt: attempt },
    steps: {
      'mac-signing-gate': { outcome },
      'upload-unsigned-inner': {
        outcome: Object.hasOwn(uploads, 'upload-unsigned-inner')
          ? uploads['upload-unsigned-inner']
          : 'success'
      },
      'upload-unsigned-windows-installer': {
        outcome: Object.hasOwn(uploads, 'upload-unsigned-windows-installer')
          ? uploads['upload-unsigned-windows-installer']
          : 'success'
      }
    }
  })
}

describe('Windows release signing waits for macOS success', () => {
  it('covers the cold runtime and packaging budget in two hosted observation jobs', () => {
    const child = parse(readFileSync('.github/workflows/release-mac-build.yml', 'utf8')).jobs[
      'build-mac'
    ]
    const dispatch = jobs['build-mac'].steps.find((step) => step.id === 'dispatch')
    const options = readReleaseMacBuildWorkflowOptions({
      GITHUB_REPOSITORY: 'stablyai/orca',
      GITHUB_RUN_ID: '1',
      GITHUB_TOKEN: 'test',
      RELEASE_MAC_BUILD_REF: 'main',
      RELEASE_MAC_BUILD_TAG: 'v1.2.3',
      ...dispatch.env
    })
    const observationMinutes = Number(dispatch.env.RELEASE_MAC_BUILD_OBSERVE_MINUTES)
    expect(child['timeout-minutes']).toBe(360)
    expect(options.timeoutMinutes).toBeGreaterThanOrEqual(child['timeout-minutes'] + 30)
    expect(observationMinutes).toBe(180)
    expect(jobs['build-mac']['timeout-minutes']).toBeGreaterThan(observationMinutes)
    expect(jobs['verify-mac-build']['timeout-minutes']).toBeGreaterThan(
      options.timeoutMinutes - observationMinutes
    )
    for (const job of [jobs['build-mac'], jobs['verify-mac-build'], jobs.build]) {
      expect(job['timeout-minutes']).toBeLessThanOrEqual(360)
    }
  })

  it('waits outside the Windows runner, then verifies the exact macOS run before signing', () => {
    expect(jobs.build.needs).toContain('build-mac')
    expect(jobs.build.if).toContain("needs.build-mac.result == 'success'")
    expect(jobs.build.needs).toContain('verify-mac-build')
    expect(jobs.build.if).toContain("needs.verify-mac-build.result == 'success'")
    expect(jobs['build-mac'].needs).not.toContain('build')
    expect(jobs['verify-mac-build'].needs).not.toContain('build')
    const windows = jobs.build.strategy.matrix.include.find((entry) => entry.platform === 'win')
    expect(windows.release_command).toMatch(
      /^node config\/scripts\/ensure-native-runtime\.mjs --runtime=electron; if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}; pnpm exec electron-builder /
    )
    const packaging = steps.findIndex((step) => step.name === 'Build Windows release artifacts')
    expect(steps[packaging].env.ORCA_REUSE_PREPARED_NATIVE_RUNTIME).toBe('1')
    const gateIndex = steps.indexOf(gate)
    expect(packaging).toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeGreaterThan(packaging)
    expect(gate.run).toBe('node config/scripts/run-release-mac-build-workflow.mjs wait')
    expect(gate.if).toBe("matrix.platform == 'win' && github.run_attempt == 1")
    expect(gate['continue-on-error']).toBeUndefined()
    expect(gate.env).toEqual(
      jobs['verify-mac-build'].steps.find((step) => step.run === gate.run).env
    )
    expect(gate.env.RELEASE_MAC_BUILD_RUN_ID).toBe('${{ needs.build-mac.outputs.run_id }}')
    expect(gate.env.RELEASE_MAC_BUILD_WORKFLOW_SHA).toBe(
      '${{ needs.build-mac.outputs.workflow_sha }}'
    )
    expect(gate.env.RELEASE_MAC_BUILD_RUN_ATTEMPT).toBe(
      '${{ needs.build-mac.outputs.run_attempt }}'
    )
    expect(gate.env.RELEASE_MAC_BUILD_WAIT_DEADLINE_MS).toBe(
      '${{ needs.build-mac.outputs.wait_deadline_ms }}'
    )
    expect(submissions).toHaveLength(2)
    for (const submission of submissions) {
      expect(steps.indexOf(submission)).toBeGreaterThan(gateIndex)
    }
  })

  it('allows neither signing request without successful macOS verification and upload', () => {
    const uploadBySubmission = {
      'submit-inner-signing': 'upload-unsigned-inner',
      'submit-signing-request': 'upload-unsigned-windows-installer'
    }
    for (const submission of submissions) {
      const upload = uploadBySubmission[submission.id]
      expect(upload).toBeDefined()
      const otherUpload = Object.values(uploadBySubmission).find((id) => id !== upload)
      expect(signingAllowed(submission, 'success')).toBe(true)
      expect(signingAllowed(submission, 'success', 1, 'win', { [otherUpload]: 'failure' })).toBe(
        true
      )
      for (const outcome of ['failure', 'cancelled', 'skipped', '', undefined]) {
        expect(signingAllowed(submission, outcome), `${submission.id}: ${outcome}`).toBe(false)
        expect(signingAllowed(submission, 'success', 1, 'win', { [upload]: outcome })).toBe(false)
      }
      for (const attempt of [2, 3]) {
        expect(signingAllowed(submission, 'success', attempt)).toBe(false)
      }
      for (const platform of ['linux-x64', 'linux-arm64']) {
        expect(signingAllowed(submission, 'success', 1, platform)).toBe(false)
      }
    }
  })

  it('restores the verifier from the workflow commit when releasing older sources', () => {
    const restore = steps.find((step) =>
      step.run?.includes(
        'git checkout "$WORKFLOW_SHA" -- config/scripts/assert-github-release-is-draft.mjs'
      )
    )
    expect(restore.env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}')
    expect(restore.run).toContain('config/scripts/run-release-mac-build-workflow.mjs')
    expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(gate))
  })

  it('runs the verifier CLI from paths requiring URL encoding, as Windows paths do', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca signing gate # % ')))
    const script = join(directory, 'mac verifier.mjs')
    writeFileSync(script, readFileSync('config/scripts/run-release-mac-build-workflow.mjs'))
    try {
      const result = await runProcess({
        program: process.execPath,
        args: [script, 'wait'],
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          RELEASE_MAC_BUILD_REF: 'main',
          GITHUB_REPOSITORY: 'stablyai/orca',
          GITHUB_RUN_ID: '777',
          GITHUB_TOKEN: 'test-token',
          RELEASE_MAC_BUILD_TAG: 'v1.2.3',
          RELEASE_MAC_BUILD_RUN_ID: ''
        }
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('RELEASE_MAC_BUILD_RUN_ID is required')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
