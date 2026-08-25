import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { PR_E2E_SOURCE_ROUTES, selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
const e2eWorkflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))
const reliabilityManifest = parseJsonc(
  readFileSync(join(projectDir, 'config/reliability-gates.jsonc'), 'utf8')
)
const playwrightConfig = readFileSync(join(projectDir, 'tests/playwright.config.ts'), 'utf8')
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
    // Why lastIndexOf: the docs-only branch has its own loop that allows skipped.
    const successMarker = '# Require success when the PR has code-relevant changes'
    const successLoop = verifyStep.run.slice(
      verifyStep.run.indexOf(successMarker),
      verifyStep.run.lastIndexOf('done')
    )
    expect(successLoop.length).toBeGreaterThan(0)
    for (const job of prWorkflow.jobs.verify.needs) {
      const envVar = job.toUpperCase()
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.${job}.result }}`)
      expect(successLoop).toContain(`"$${envVar}"`)
    }
  })

  it('selects modified Playwright specs without running deleted tests', () => {
    expect(filterStep.run).toContain('--diff-filter=AMCR')
    expect(filterStep.run).toContain('config/scripts/pr-e2e-source-routing.mjs')
    expect(filterStep.run).not.toContain('tests/playwright\\.')
    expect(
      selectPrE2eSpecs([
        'tests/e2e/active-view-restart-restore.spec.ts',
        'tests/e2e/deleted.spec.ts.bak',
        'tests/e2e/global-teardown.unit.test.ts'
      ])
    ).toEqual(['tests/e2e/active-view-restart-restore.spec.ts'])
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
    expect(playwrightConfig).toContain('retries: 0')
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
      const workflow = parseYaml(readFileSync(join(projectDir, '.github/workflows', file), 'utf8'))
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
      'src/main/ipc/pty',
      'src/relay/',
      'src/renderer/src/components/terminal-pane/remote-runtime-'
    ]
    for (const authority of sshSourceAuthorities) {
      expect(selectPrE2eSpecs([`${authority}routing.ts`])).toContain(
        'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts'
      )
    }

    const mappedSpecs = [
      'tests/e2e/pty-input-write-queue-ssh.spec.ts',
      'tests/e2e/ssh-cold-activation-restore.spec.ts',
      'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
      'tests/e2e/ssh-startup-exec-readiness.spec.ts',
      'tests/e2e/ssh-terminal-window-wake-stale-grid-repro.spec.ts'
    ]
    for (const spec of mappedSpecs) {
      expect(selectPrE2eSpecs(['src/main/ssh/connection.ts'])).toContain(spec)
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
      // Why: a spec that stops reading the flag would silently run without Docker.
      if (spec !== 'tests/e2e/ssh-startup-exec-readiness.spec.ts') {
        expect(readFileSync(join(projectDir, spec), 'utf8'), spec).toContain('ORCA_E2E_SSH_DOCKER')
      }
    }

    expect(selectPrE2eSpecs(['src/main/ssh/connection.test.ts'])).toEqual([])

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
    expect(selectPrE2eSpecs(['src/shared/ephemeral-vm-recipes.ts'])).toEqual([
      'tests/e2e/ephemeral-vm-provisioned-root.spec.ts'
    ])
  })

  it('routes P0 sentinels from their causal sources', () => {
    const cases = [
      [
        'src/renderer/src/components/tab-bar/TabBarQuickCommandsMenu.tsx',
        'tests/e2e/terminal-quick-command-pre-bind-recovery.spec.ts'
      ],
      ['src/main/runtime/orca-runtime-files.ts', 'tests/e2e/paired-quick-open-large-tree.spec.ts'],
      [
        'src/renderer/src/runtime/sync-runtime-graph.ts',
        'tests/e2e/host-parked-pane-remote-viewer.spec.ts'
      ],
      [
        'src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts',
        'tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts'
      ],
      [
        'src/renderer/src/components/terminal-pane/remote-pane-layout-push.ts',
        'tests/e2e/paired-remote-pane-layout-retry.spec.ts'
      ]
    ]
    for (const [source, spec] of cases) {
      expect(selectPrE2eSpecs([source]), source).toEqual([spec])
      expect(selectPrE2eSpecs([source.replace(/\.tsx?$/, '.test.ts')]), source).toEqual([])
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
    const quickCommandSpec = 'tests/e2e/terminal-quick-command-pre-bind-recovery.spec.ts'
    for (const source of [
      'src/renderer/src/components/terminal-pane/pty-connection.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/connect-pane-pty.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/fresh-spawn-start.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/pane-pty-visibility-bind.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/pty-input-recovery.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(quickCommandSpec)
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).not.toContain(
        quickCommandSpec
      )
    }
    for (const source of [
      'src/main/ipc/rg-availability.ts',
      'src/shared/ripgrep-process-availability.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toEqual([
        'tests/e2e/paired-quick-open-large-tree.spec.ts'
      ])
    }
    expect(
      selectPrE2eSpecs([
        'src/main/runtime/orca-runtime-files.ts',
        'tests/e2e/paired-quick-open-large-tree.spec.ts'
      ])
    ).toEqual(['tests/e2e/paired-quick-open-large-tree.spec.ts'])
    expect(selectPrE2eSpecs(['src/renderer/src/components/FileExplorer.tsx'])).toEqual([])
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts'
      ])
    ).toContain('tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts')
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport-test-harness.ts'
      ])
    ).not.toContain('tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts')
    expect(selectPrE2eSpecs(['src/main/ipc/pty.ts'])).not.toContain(
      'tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts'
    )
  })

  it('keeps source-routed sentinels registered to their reliability gates', () => {
    const routedGateIds = [
      'terminal-startup.quick-command-pre-bind-recovery',
      'quick-open.paired-host-path-search',
      'terminal-session.host-cold-park-stream-continuity',
      'terminal-provider.ssh-remote-reattach-contract',
      'terminal-session.remote-pane-layout-retry'
    ]
    for (const gateId of routedGateIds) {
      const route = PR_E2E_SOURCE_ROUTES.find((candidate) => candidate.id === gateId)
      const gate = reliabilityManifest.gates.find((candidate) => candidate.id === gateId)
      expect(route, gateId).toBeDefined()
      expect(gate, gateId).toMatchObject({ maturity: 'experimental', protection: 'partial' })
      for (const spec of route.specs) {
        expect(gate.testFiles, gateId).toContain(spec)
        expect(
          gate.commands.some((command) => command.includes(spec)),
          gateId
        ).toBe(true)
      }
    }
  })
})
