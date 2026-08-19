import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
const e2eWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))
const sshDockerRunner = readFileSync(
  join(projectDir, 'config/scripts/run-ssh-docker-terminal-parking-e2e.mjs'),
  'utf8'
)

const filterStep = prWorkflow.jobs['e2e-paths'].steps.find(
  (step) => step.name === 'Filter changed E2E specs'
)
const rollbackStep = prWorkflow.jobs.static_analysis.steps.find(
  (step) => step.name === 'Check VM runtime rollback compatibility'
)
const verifyStep = prWorkflow.jobs.verify.steps.find(
  (step) => step.name === 'Require successful checks'
)

describe('PR E2E gate contract', () => {
  it('keeps E2E advisory while the suite is red on main', () => {
    // Why: pin the deliberate choice so it reads as intentional rather than as
    // the "forgot to wire the gate" bug this file originally caught. Gating on a
    // suite that fails every scheduled run would block the PRs that fix it.
    // Flipping to blocking means updating this expectation too — see the comment
    // on verify's Require-successful-checks step for the exact wiring.
    expect(prWorkflow.jobs.verify.needs).not.toContain('e2e')
    expect(verifyStep.env.E2E).toBeUndefined()
    expect(verifyStep.run).not.toContain('$E2E')
  })

  it('passes only changed specs to the reusable E2E workflow', () => {
    // Why: without this the job could lose its filter and run on every PR — the
    // cost the path filter exists to avoid — while the gate assertions above
    // stay green.
    expect(prWorkflow.jobs.e2e.needs).toBe('e2e-paths')
    expect(prWorkflow.jobs.e2e.if).toBe("needs.e2e-paths.outputs.should_run == 'true'")
    expect(prWorkflow.jobs['e2e-paths'].outputs.should_run).toBe(
      '${{ steps.filter.outputs.should_run }}'
    )
    expect(prWorkflow.jobs['e2e-paths'].outputs.test_files).toBe(
      '${{ steps.filter.outputs.test_files }}'
    )
    expect(prWorkflow.jobs.e2e.with.test_files).toBe('${{ needs.e2e-paths.outputs.test_files }}')
  })

  it('enforces every job verify depends on', () => {
    // Why: derive from verify.needs rather than hardcoding, so adding a required
    // job without adding it to the strict loop fails here instead of silently
    // leaving that job unenforced. This is what caught GIT_COMPATIBILITY and
    // SHELL_CONTRACTS being absent from an earlier hardcoded list.
    const strictLoop = verifyStep.run.slice(0, verifyStep.run.indexOf('done'))
    for (const job of prWorkflow.jobs.verify.needs) {
      const envVar = job.toUpperCase()
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.${job}.result }}`)
      expect(strictLoop).toContain(`"$${envVar}"`)
    }
  })

  it('selects modified Playwright specs without running deleted tests', () => {
    expect(filterStep.run).toContain('--diff-filter=AMCR')
    expect(filterStep.run).toContain("'^tests/e2e/.*\\.spec\\.ts$'")
    expect(filterStep.run).not.toContain('tests/playwright\\.')
  })

  it('uses one runner for changed specs and keeps full runs sharded', () => {
    expect(e2eWorkflow.jobs.e2e.if).toBe("inputs.test_files == ''")
    expect(e2eWorkflow.jobs['changed-e2e'].if).toBe("inputs.test_files != ''")
    expect(e2eWorkflow.jobs['changed-e2e'].strategy).toBeUndefined()
    const changedRun = e2eWorkflow.jobs['changed-e2e'].steps.find(
      (step) => step.name === 'Run changed E2E specs'
    )
    expect(changedRun.env.TEST_FILES_JSON).toBe('${{ inputs.test_files }}')
    expect(changedRun.run).toContain('. != "tests/e2e/ssh-startup-exec-readiness.spec.ts"')
    expect(changedRun.run).toContain('. != "tests/e2e/paired-startup-exec-readiness.spec.ts"')
    expect(changedRun.run).toContain('if [ "${#TEST_FILES[@]}" -eq 0 ]')
    expect(changedRun.run).toContain('grep -l \'@headful\' "${TEST_FILES[@]}"')
    expect(changedRun.run).toContain('E2E_PROJECT_ARGS+=(--project=electron-headful)')
    expect(changedRun.run).toContain(
      'pnpm run test:e2e "${TEST_FILES[@]}" --workers=1 "${E2E_PROJECT_ARGS[@]}"'
    )
  })

  it('keeps startup-exec live parity in the isolated SSH lane', () => {
    const sshLaneCondition = e2eWorkflow.jobs['ssh-docker-watcher-isolation'].if
    expect(sshLaneCondition).toContain("inputs.test_files == ''")
    expect(sshLaneCondition).toContain('tests/e2e/ssh-startup-exec-readiness.spec.ts')
    expect(sshLaneCondition).toContain('tests/e2e/paired-startup-exec-readiness.spec.ts')
    expect(sshDockerRunner).toContain('tests/e2e/ssh-startup-exec-readiness.spec.ts')
    expect(sshDockerRunner).toContain('tests/e2e/paired-startup-exec-readiness.spec.ts')
    expect(sshDockerRunner).toContain("'electron-headless'")
    expect(sshDockerRunner).toContain("'electron-headful'")
  })

  it('installs zsh in every Linux lane that can run paired startup readiness', () => {
    for (const jobName of ['e2e', 'changed-e2e', 'ssh-docker-watcher-isolation']) {
      const installStep = e2eWorkflow.jobs[jobName].steps.find((step) =>
        step.name.startsWith('Install native build')
      )
      expect(installStep.run, jobName).toMatch(/\bzsh\b/)
    }
  })

  it('keeps dedicated E2E workflows out of pull request CI', () => {
    const dedicatedWorkflows = [
      'golden-e2e-experiment.yml',
      'linux-wayland-gpu-sandbox.yml',
      'terminal-ime-e2e.yml',
      'win-crash-survival-e2e.yml',
      'windows-terminal-restart-e2e.yml'
    ]

    for (const file of dedicatedWorkflows) {
      const workflow = parse(readFileSync(join(projectDir, '.github/workflows', file), 'utf8'))
      expect(workflow.on.pull_request, file).toBeUndefined()
    }
  })

  it('scopes detection to the PR range so base drift cannot false-trigger', () => {
    expect(filterStep.run).toContain('--merge-base "$BASE" "$HEAD"')
    expect(filterStep.run).toContain('set -euo pipefail')
  })

  it('maps SSH source edits onto the Docker-backed specs they can break', () => {
    // Why: the Docker-SSH specs self-skip without ORCA_E2E_SSH_DOCKER, and the only
    // trigger used to be "someone edited a spec" — four pane-restore regressions shipped
    // through that hole. Each mapped spec must exist, or the lane runs an empty file list.
    const sshSourceAuthorities = [
      'src/main/ssh/',
      'src/main/providers/ssh-',
      'src/main/ipc/(ssh-|pty)',
      'src/relay/',
      'src/renderer/src/components/terminal-pane/(pty-|ssh-|remote-runtime-|terminal-parked-pty)'
    ]
    for (const authority of sshSourceAuthorities) {
      expect(filterStep.run).toContain(authority)
    }

    const mappedSpecs = [
      'tests/e2e/pty-input-write-queue-ssh.spec.ts',
      'tests/e2e/ssh-cold-activation-restore.spec.ts',
      'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
      'tests/e2e/ssh-startup-exec-readiness.spec.ts',
      'tests/e2e/ssh-terminal-window-wake-stale-grid-repro.spec.ts'
    ]
    for (const spec of mappedSpecs) {
      expect(filterStep.run).toContain(`'${spec}'`)
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
      // Why: a spec that stops reading the flag would silently run without Docker.
      if (spec !== 'tests/e2e/ssh-startup-exec-readiness.spec.ts') {
        expect(readFileSync(join(projectDir, spec), 'utf8'), spec).toContain('ORCA_E2E_SSH_DOCKER')
      }
    }

    // Why: unit tests next to the mapped sources prove the same code without Docker.
    expect(filterStep.run).toContain("grep -Ev '\\.test\\.tsx?$'")

    // Why: startup readiness is filtered out of changed-e2e, so listing it is only
    // meaningful while it still routes the dedicated Docker lane.
    expect(e2eWorkflow.jobs['ssh-docker-watcher-isolation'].if).toContain(
      'tests/e2e/ssh-startup-exec-readiness.spec.ts'
    )

    // Why: this lane can now pay a Docker image build plus serial SSH specs.
    expect(e2eWorkflow.jobs['changed-e2e']['timeout-minutes']).toBeGreaterThanOrEqual(45)
    const changedInstall = e2eWorkflow.jobs['changed-e2e'].steps.find((step) =>
      step.name.startsWith('Install native build')
    )
    expect(changedInstall.run).toContain('openssh-client')
  })

  it('scopes the VM rollback oracle to the PR range and recipe schema authorities', () => {
    expect(rollbackStep.run).toContain('--merge-base "$BASE_SHA" "$HEAD_SHA"')
    expect(rollbackStep.run).toContain('src/shared/ephemeral-vm-recipes.ts')
    expect(rollbackStep.run).toContain('src/shared/orca-yaml-hook-types.ts')
    expect(filterStep.run).toContain('ephemeral-vm-recipes|orca-yaml-hook-types')
  })
})
