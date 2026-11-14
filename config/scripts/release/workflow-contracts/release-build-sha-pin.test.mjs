// Builds check out the commit release-cut recorded, never the movable tag name.
import { readFileSync } from 'node:fs'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { dispatchReleaseMacBuildWorkflow } from '../operations/run-release-mac-build-workflow.mjs'

const releaseCutText = readFileSync('.github/workflows/release-cut.yml', 'utf8')
const releaseCut = parse(releaseCutText)
const macBuild = parse(readFileSync('.github/workflows/release-mac-build.yml', 'utf8'))
const RELEASE_SHA = '${{ needs.cut.outputs.release_sha }}'

describe('release builds check out the verified commit', () => {
  it('pins every tag checkout and reusable build to the cut release SHA, then asserts HEAD', () => {
    expect(releaseCutText).not.toContain('refs/tags/${{ needs.cut.outputs.tag }}')
    let checkouts = 0
    for (const [name, job] of Object.entries(releaseCut.jobs)) {
      if (job.uses && job.with?.ref) {
        expect(job.with.ref, name).toBe(RELEASE_SHA)
      }
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.with?.ref?.includes('needs.cut')) {
          continue
        }
        checkouts += 1
        expect(step.with.ref, name).toBe(RELEASE_SHA)
        const next = job.steps.slice(index + 1, index + 3).map((s) => s.name)
        expect(next, name).toContain('Verify checkout is the release commit')
      }
    }
    expect(checkouts).toBe(6)
  })

  it('pins the macOS build to the dispatched release SHA and keeps inputs out of shell', async () => {
    const steps = macBuild.jobs['build-mac'].steps
    expect(steps[0].with.ref).toBe(
      '${{ inputs.qualification_only && github.sha || inputs.release_sha }}'
    )
    expect(steps[1].env.RELEASE_SHA).toBe('${{ inputs.release_sha }}')
    let body
    await dispatchReleaseMacBuildWorkflow(
      { owner: 'o', repo: 'r', request: async (_method, _path, value) => (body = value) },
      { releaseRunId: '1', tag: 'v1.2.3', releaseSha: 'a'.repeat(40), ref: 'main', workflow: 'w' }
    )
    expect(body.inputs.release_sha).toBe('a'.repeat(40))
    for (const step of steps) {
      expect(step.run ?? '', step.name).not.toContain('${{ inputs.')
    }
  })

  const verifyRun = releaseCut.jobs['create-release'].steps.find(
    (step) => step.name === 'Verify checkout is the release commit'
  ).run
  it.skipIf(process.platform === 'win32').each([
    ['matching', (head) => head, 0],
    ['moved', () => 'e'.repeat(40), 1],
    ['empty', () => '', 1]
  ])('HEAD assertion: %s', (_name, releaseSha, code) => {
    const head = runProcessSync({ program: 'git', args: ['rev-parse', 'HEAD'] }).stdout.trim()
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', verifyRun],
      env: { ...process.env, RELEASE_SHA: releaseSha(head) }
    })
    expect(result.code).toBe(code)
  })
})
