import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  hasNativeImeSourceChange,
  hasSshSourceChange,
  NATIVE_IME_SOURCE_ROUTE_IDS,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs,
  SSH_SOURCE_ROUTE_IDS
} from './pr-e2e-source-routing.mjs'
import {
  EXPECTED_NATIVE_IME_TESTS,
  IME_ENGAGEMENT_RECEIPT_ENV
} from './terminal-ime-engagement-receipt.mjs'

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
const nativeImeWorkflow = parseYaml(
  readFileSync(join(projectDir, '.github/workflows/terminal-ime-e2e.yml'), 'utf8')
)
const nativeImeRunner = readFileSync(
  join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
  'utf8'
)
const nativeImeSpec = readFileSync(
  join(projectDir, 'tests/e2e/terminal-ibus-hangul-native.spec.ts'),
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

/** The route that sends a change to the two-Electron restart-survival spec. */
const restartSurvivalRoute = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'client-hosted-browser.restart-survival'
)

describe('restart-survival E2E routing', () => {
  // Every file below carries behavior the restart spec is the only test that exercises end to end.
  it.each([
    'src/main/runtime/orca-runtime.ts',
    'src/main/runtime/orca-runtime-browser.ts',
    'src/main/runtime/client-hosted-page-reconciliation-window.ts',
    'src/main/runtime/runtime-browser-client-page-adoption.ts',
    'src/main/runtime/runtime-browser-client-page-recovery.ts',
    'src/main/runtime/browser-host-client-page-adoption.ts',
    'src/main/runtime/browser-host-page-reconciliation-orchestration.ts',
    'src/main/runtime/rpc/methods/browser-client-host.ts',
    'src/main/browser/browser-client-host-authority-replacement-wait.ts',
    'src/main/browser/paired-runtime-browser-client-host-composition.ts',
    'src/renderer/src/runtime/web-session-tabs-sync.ts',
    'src/renderer/src/runtime/host-session-snapshot-authority.ts',
    'src/renderer/src/runtime/restored-client-hosted-browser-host-attach.ts',
    'src/renderer/src/store/slices/runtime-status.ts',
    'src/shared/runtime-types.ts',
    'src/shared/browser-client-host-protocol.ts'
  ])('routes %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(true)
  })

  // The pattern is deliberately not "anything under src": routing every PR at a two-Electron spec
  // is the cost the filter exists to avoid.
  it.each([
    'src/main/git/git-status.ts',
    'src/renderer/src/components/tab-bar/BrowserTab.tsx',
    'src/main/terminal/pty-manager.ts',
    // The status/types entries name whole files, not a suffix any longer name may end with.
    'src/shared/computer-use-runtime-types.ts'
  ])('does not route %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(false)
  })
})

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
    expect(prWorkflow.jobs.e2e.with.ref).toBe('${{ github.event.pull_request.head.sha }}')
    expect(prWorkflow.jobs.e2e.with.test_files).toBe('${{ needs.e2e-paths.outputs.test_files }}')
  })

  it('enforces every job verify depends on', () => {
    // Why: derive from verify.needs rather than hardcoding, so adding a required
    // job without adding it to the strict loop fails here instead of silently
    // leaving that job unenforced. This is what caught GIT_COMPATIBILITY and
    // SHELL_CONTRACTS being absent from an earlier hardcoded list.
    const successMarker = '# Require success when the PR has code-relevant changes'
    const successLoop = verifyStep.run.slice(verifyStep.run.indexOf(successMarker))
    expect(successLoop.length).toBeGreaterThan(0)
    expect(verifyStep.run).toContain('"$CODE_PATHS" != "success"')
    expect(verifyStep.run).toContain('"$ROOT_DIRECTORY_GUARD" != "success"')
    for (const job of prWorkflow.jobs.verify.needs) {
      const envVar = job.replaceAll('-', '_').toUpperCase()
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.${job}.result }}`)
      if (job === 'code_paths' || job === 'root_directory_guard') {
        continue
      }
      expect(successLoop).toContain(`"$${envVar}"`)
      expect(verifyStep.env[`${envVar}_SHOULD_RUN`]).toBe(`\${{ needs.code_paths.outputs.${job} }}`)
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
    expect(e2eWorkflow.jobs.e2e.strategy.matrix.include).toEqual(
      Array.from({ length: 14 }, (_, index) => ({
        shard: `${index + 1}/14`,
        shard_name: `${index + 1}-of-14`
      }))
    )
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

  it('reuses the composite install action instead of duplicating pnpm setup', () => {
    const installFor = (jobName) =>
      e2eWorkflow.jobs[jobName].steps.find(
        (step) => step.uses === './.github/actions/install-node-dependencies'
      )

    expect(installFor('build').with['native-runtime']).toBe('node')
    for (const jobName of ['e2e', 'changed-e2e', 'ssh-docker-watcher-isolation']) {
      expect(installFor(jobName).with['native-runtime'], jobName).toBe('electron')
    }
  })

  it('installs zsh in every Linux lane that can run paired startup readiness', () => {
    for (const jobName of ['e2e', 'changed-e2e', 'ssh-docker-watcher-isolation']) {
      const installStep = e2eWorkflow.jobs[jobName].steps.find((step) =>
        step.name.startsWith('Install native build')
      )
      expect(installStep.run, jobName).toMatch(/\bzsh\b/)
    }
  })

  it('keeps dedicated E2E workflows from self-triggering on pull requests', () => {
    // Why this still holds for terminal-ime-e2e.yml now that pr.yml runs it: pr.yml reaches it
    // through workflow_call, behind the path filter. A pull_request trigger here would run a
    // real ibus session on every PR, which is the cost the filter exists to avoid.
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
      'src/shared/ssh-',
      'src/renderer/src/store/slices/direct-ssh-',
      'src/renderer/src/components/terminal-pane/remote-runtime-'
    ]
    for (const authority of sshSourceAuthorities) {
      expect(selectPrE2eSpecs([`${authority}routing.ts`])).toContain(
        'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts'
      )
    }

    // Why named files rather than prefixes: these seams are single modules, and a prefix
    // here would route their unrelated neighbours.
    for (const file of [
      'src/main/runtime/public-ssh-state.ts',
      'src/renderer/src/startup/ssh-startup-reconnect.ts',
      'src/renderer/src/store/slices/ssh.ts'
    ]) {
      expect(selectPrE2eSpecs([file]), file).toContain(
        'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts'
      )
    }

    const mappedSpecs = [
      'tests/e2e/pty-input-write-queue-ssh.spec.ts',
      'tests/e2e/ssh-cold-activation-restore.spec.ts',
      'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
      'tests/e2e/ssh-docker-transport-drop-recovery.spec.ts',
      'tests/e2e/ssh-port-forward-lifecycle.spec.ts',
      'tests/e2e/ssh-reconnect-tab-destruction.spec.ts',
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

  it('routes direct-SSH workspace and tab restore from its unnamed source seams', () => {
    // Why by name: none of these carry "ssh", so the SSH authorities above never reach them
    // — a closed-tab tombstone and a dropped default-tabs marker both shipped through it.
    for (const file of [
      'src/renderer/src/hooks/remote-workspace-session-merge.ts',
      'src/main/ipc/remote-workspace-snapshot-normalization.ts',
      'src/renderer/src/lib/worktree-initial-terminal-seeding.ts',
      'src/renderer/src/lib/worktree-default-terminal-tabs.ts',
      'src/shared/remote-workspace-session-projection.ts',
      'src/renderer/src/components/terminal/initial-terminal.ts'
    ]) {
      const specs = selectPrE2eSpecs([file])
      expect(specs, file).toContain('tests/e2e/ssh-cold-activation-restore.spec.ts')
      expect(specs, file).toContain('tests/e2e/ssh-reconnect-tab-destruction.spec.ts')
    }

    expect(
      selectPrE2eSpecs(['src/renderer/src/hooks/remote-workspace-session-merge.test.ts'])
    ).toEqual([])
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/hooks/__tests__/remote-workspace-target-sync-test-harness.ts'
      ])
    ).toEqual([])
  })

  it('triggers the Docker-SSH lane from SSH source, not from a spec name', () => {
    // The behavioural half of the invariant, and the part that actually matters: an SSH source
    // edit is recognised as one, through the same routes that select the specs.
    for (const file of [
      'src/main/ssh/connection.ts',
      'src/relay/pty-handler.ts',
      'src/renderer/src/store/slices/direct-ssh-pane-retry-ledger.ts',
      'src/renderer/src/hooks/remote-workspace-session-merge.ts',
      'src/main/ipc/remote-workspace-snapshot-normalization.ts'
    ]) {
      expect(hasSshSourceChange([file]), file).toBe(true)
    }
    for (const file of [
      'src/main/git/git-status.ts',
      'src/renderer/src/components/tab-bar/BrowserTab.tsx',
      'src/main/ssh/connection.test.ts'
    ]) {
      expect(hasSshSourceChange([file]), file).toBe(false)
    }

    // Why: the signal must stay derived from the routes. A route id that no longer exists would
    // silently narrow it to nothing.
    for (const id of SSH_SOURCE_ROUTE_IDS) {
      expect(
        PR_E2E_SOURCE_ROUTES.map((route) => route.id),
        id
      ).toContain(id)
    }

    // Why text and not structure: a job `if:` is only ever available as a string. The strongest
    // available assertion is that the source signal is its own disjunct, so the lane no longer
    // depends on a spec name surviving in a route's spec list.
    const sshLaneCondition = e2eWorkflow.jobs['ssh-docker-watcher-isolation'].if
    expect(sshLaneCondition).toContain("inputs.ssh_source_changed == 'true' ||")

    expect(e2eWorkflow.on.workflow_call.inputs.ssh_source_changed.type).toBe('string')
    expect(prWorkflow.jobs['e2e-paths'].outputs.ssh_source_changed).toBe(
      '${{ steps.filter.outputs.ssh_source_changed }}'
    )
    expect(prWorkflow.jobs.e2e.with.ssh_source_changed).toBe(
      '${{ needs.e2e-paths.outputs.ssh_source_changed }}'
    )
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --ssh-source')
    expect(filterStep.run).toContain('ssh_source_changed=$SSH_SOURCE_CHANGED')
  })

  it('gives every Docker-gated SSH spec a lane that runs it', () => {
    // Why this shape: the sharded lanes set no ORCA_E2E_SSH_DOCKER, so a Docker-gated spec
    // that no runner names runs nowhere and still reports green — the silent skip this file
    // exists to prevent. Asserting reachability rather than a literal keeps that true when
    // the lanes move.
    // Why these two are exempt: each needs something CI cannot give it, recorded in
    // run-ssh-docker-e2e.mjs so the gap stays legible rather than looking like coverage.
    const unreachableSpecs = new Set([
      'tests/e2e/ssh-docker-relay-perf.spec.ts',
      'tests/e2e/ssh-codex-display-artifacts-repro.spec.ts',
      'tests/e2e/ssh-docker-bulk-open-freeze-repro.spec.ts'
    ])
    // Why comments are stripped: this file's own runner lists the two exempt specs by name in a
    // prose comment. A substring scan over raw text would count any spec merely *discussed* in a
    // runner as claimed by it -- the silent skip this assertion exists to catch, re-entering
    // through the documentation.
    const stripComments = (text) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const laneRunners = [
      'run-ssh-docker-e2e.mjs',
      'run-ssh-docker-watcher-isolation-e2e.mjs',
      'run-ssh-docker-terminal-parking-e2e.mjs'
    ].map((file) => stripComments(readFileSync(join(projectDir, 'config/scripts', file), 'utf8')))

    // Why a comparison and not the bare name: preview and demo specs cite the flag in a
    // "how to run me" comment without gating on it. Why a regex rather than one literal: an
    // equally-valid spelling (double quotes, or a `!==` guard) would escape a fixed-string scan
    // and the spec would silently leave the contract.
    const dockerGateExpression = /ORCA_E2E_SSH_DOCKER\s*[!=]==\s*['"]1['"]/
    const dockerGatedSpecs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => `tests/e2e/${file}`)
      .filter((spec) => dockerGateExpression.test(readFileSync(join(projectDir, spec), 'utf8')))
    expect(dockerGatedSpecs.length).toBeGreaterThan(0)

    const unclaimed = dockerGatedSpecs.filter(
      (spec) => !unreachableSpecs.has(spec) && !laneRunners.some((runner) => runner.includes(spec))
    )
    expect(
      unclaimed,
      `Docker-gated specs claimed by no lane runner: ${unclaimed.join(', ')}`
    ).toEqual([])

    // Why: an exemption that outlives its spec would quietly excuse a real gap.
    for (const spec of unreachableSpecs) {
      expect(dockerGatedSpecs, spec).toContain(spec)
      // Why also assert absence from every runner: `unreachableSpecs` short-circuits the
      // unclaimed check above, so a spec could be documented as exempt while a runner still
      // invokes it -- an exemption that reads as coverage removal but changes nothing, and a
      // lane that stays red for a reason the file says it excluded.
      for (const runner of laneRunners) {
        expect(runner.includes(spec), `${spec} is exempt but still invoked by a lane runner`).toBe(
          false
        )
      }
    }

    const laneStep = e2eWorkflow.jobs['ssh-docker-watcher-isolation'].steps.find(
      (step) => step.name === 'Run remaining Docker SSH E2E'
    )
    expect(laneStep.run).toContain('test:e2e:ssh-docker')
    // Why: the added serial tests, several budgeting 4-10 minutes each, do not fit the old 35.
    expect(
      e2eWorkflow.jobs['ssh-docker-watcher-isolation']['timeout-minutes']
    ).toBeGreaterThanOrEqual(60)
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
    const parkedSplitSpec = 'tests/e2e/terminal-parked-cli-split.spec.ts'
    for (const source of [
      'src/main/window/attach-main-window-services.ts',
      'src/preload/api/ui-command-event-api.ts',
      'src/preload/index.ts',
      'src/renderer/src/components/terminal-pane/terminal-pane-split-request-routing.ts',
      'src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts',
      'src/renderer/src/components/terminal-pane/use-terminal-tab-cold-parking.ts',
      'src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(parkedSplitSpec)
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).not.toContain(
        parkedSplitSpec
      )
    }
    expect(existsSync(join(projectDir, parkedSplitSpec)), parkedSplitSpec).toBe(true)

    const restartContinuitySpec = 'tests/e2e/paired-remote-terminal-serve-restart-binding.spec.ts'
    for (const source of [
      'src/main/daemon/daemon-attach-only-retirement.ts',
      'src/main/daemon/daemon-pty-applied-size.ts',
      'src/main/daemon/daemon-pty-session-control.ts',
      'src/main/daemon/daemon-pty-spawn-result.ts',
      'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts',
      'src/renderer/src/components/terminal-pane/terminal-error-accumulation.ts',
      'src/renderer/src/runtime/web-runtime-session.ts',
      'src/renderer/src/runtime/web-session-tabs-sync.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-adoption.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-surface.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-inventory.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-inventory-validation.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-cache.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-pane.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-queue.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-rpc-lane.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-topology.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(restartContinuitySpec)
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).not.toContain(
        restartContinuitySpec
      )
    }
    expect(existsSync(join(projectDir, restartContinuitySpec)), restartContinuitySpec).toBe(true)
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

  it('puts the real-IME lane on the PR gate behind the IME source filter', () => {
    // Why a whole lane and not a spec in changed-e2e: the harness is an ibus-daemon, an xfwm4
    // session, and an X11 display; the generic lane has none of them and the spec would skip.
    expect(nativeImeWorkflow.on.workflow_call).toBeDefined()
    expect(prWorkflow.jobs.terminal_ime_native.uses).toBe(
      './.github/workflows/terminal-ime-e2e.yml'
    )
    expect(prWorkflow.jobs.terminal_ime_native.needs).toBe('e2e-paths')
    expect(prWorkflow.jobs.terminal_ime_native.if).toBe(
      "needs.e2e-paths.outputs.native_ime_source_changed == 'true'"
    )
    expect(prWorkflow.jobs['e2e-paths'].outputs.native_ime_source_changed).toBe(
      '${{ steps.filter.outputs.native_ime_source_changed }}'
    )
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --native-ime-source')
    expect(filterStep.run).toContain('native_ime_source_changed=$NATIVE_IME_SOURCE_CHANGED')

    // Why: continue-on-error would report the lane green and hide every failure it exists to
    // surface. Advisory here means "absent from verify.needs", not "always passes".
    expect(prWorkflow.jobs.terminal_ime_native['continue-on-error']).toBeUndefined()
    expect(prWorkflow.jobs.verify.needs).not.toContain('terminal_ime_native')
    expect(verifyStep.env.TERMINAL_IME_NATIVE).toBeUndefined()

    for (const id of NATIVE_IME_SOURCE_ROUTE_IDS) {
      expect(
        PR_E2E_SOURCE_ROUTES.map((route) => route.id),
        id
      ).toContain(id)
    }
  })

  it('triggers the real-IME lane from every surface an input method can judge', () => {
    for (const file of [
      'src/renderer/src/components/terminal-pane/terminal-ime-composition-route.ts',
      'src/renderer/src/components/terminal-pane/terminal-ime-native-text-forwarder.ts',
      'src/renderer/src/components/terminal-pane/terminal-ios-hangul-preedit.ts',
      'src/renderer/src/components/terminal-pane/xterm-bypass-policy.ts',
      'src/renderer/src/lib/pane-manager/terminal-ime-anchor.ts',
      'src/shared/terminal-unicode-provider.ts',
      // The xterm fork owns the helper textarea the IME attaches to; no file here says "ime".
      'config/patches/@xterm__xterm@6.1.0-beta.287.patch',
      'config/patches/xterm-src/browser/Terminal.ts',
      // The harness is source too: breaking the runner or a probe is how the lane goes blind.
      'config/scripts/run-terminal-ibus-hangul-e2e.mjs',
      'config/scripts/terminal-ime-engagement-receipt.mjs',
      'tests/e2e/terminal-ime-boundary-probe.ts',
      'tests/e2e/terminal-ime-byte-reader.ts',
      'tests/e2e/terminal-ime-engagement-receipt.ts',
      'tests/e2e/terminal-ibus-hangul-native.spec.ts'
    ]) {
      expect(hasNativeImeSourceChange([file]), file).toBe(true)
    }

    // Why: a real ibus session on a Git or tab-bar edit is the cost the filter exists to avoid,
    // and a unit test beside the source must not summon a three-and-a-half-minute lane.
    for (const file of [
      'src/main/git/git-status.ts',
      'src/renderer/src/components/tab-bar/BrowserTab.tsx',
      'src/main/terminal/pty-manager.ts',
      'docs/STYLEGUIDE.md',
      'src/renderer/src/components/terminal-pane/terminal-ime-composition-route.test.ts',
      'src/renderer/src/lib/pane-manager/terminal-ime-anchor.test.ts'
    ]) {
      expect(hasNativeImeSourceChange([file]), file).toBe(false)
    }
  })

  it('gives every input-method-gated spec a lane that runs it, or an honest exemption', () => {
    // Why this shape: a spec gated on a native-IME env var that no runner sets is a skip that
    // reports as a pass. This repo already carries such specs; the point is that they are named
    // as gaps rather than counted as coverage.
    const nativeGateExpression = /ORCA_E2E_NATIVE_(?:IBUS_HANGUL|MACOS_KOREAN)\s*[!=]==\s*['"]1['"]/
    const nativeGatedSpecs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => `tests/e2e/${file}`)
      .filter((spec) => nativeGateExpression.test(readFileSync(join(projectDir, spec), 'utf8')))
    expect(nativeGatedSpecs.length).toBeGreaterThan(0)

    // Why exempt: the digit repro needs a nested gnome-shell, which no hosted runner provides
    // (headless mutter never answers RemoteDesktop.CreateSession); the macOS spec needs a real
    // macOS input source, and no macOS runner exists on any PR or scheduled lane.
    const unreachableSpecs = new Set([
      'tests/e2e/terminal-hangul-terminating-digit-native.spec.ts',
      'tests/e2e/terminal-macos-2set-korean-native.spec.ts'
    ])
    const unclaimed = nativeGatedSpecs.filter(
      (spec) => !unreachableSpecs.has(spec) && !nativeImeRunner.includes(spec)
    )
    expect(
      unclaimed,
      `Native-IME-gated specs claimed by no lane runner: ${unclaimed.join(', ')}`
    ).toEqual([])

    for (const spec of unreachableSpecs) {
      expect(nativeGatedSpecs, spec).toContain(spec)
      expect(nativeImeRunner.includes(spec), `${spec} is exempt but still invoked`).toBe(false)
    }
  })

  it('requires proof an input method engaged before the lane may report success', () => {
    // Why this is the assertion that matters: every other check in this file protects a job from
    // not running. This one protects a job that ran from having exercised nothing.
    expect(nativeImeRunner).toContain('verifyImeEngagementReceipts')
    expect(nativeImeRunner).toContain(`[IME_ENGAGEMENT_RECEIPT_ENV]: receiptPath`)
    expect(nativeImeSpec).toContain('appendImeEngagementReceipt(testInfo.title, trace)')

    // Why: the synthetic CDP step runs first in the same job. Under the default success()
    // condition its failure skipped the real-IME step, so the half that needs an input method
    // reported nothing on exactly the changes that broke IME code.
    const nativeStep = nativeImeWorkflow.jobs['linux-x11'].steps.find(
      (step) => step.name === 'Run native IBus Hangul exact-byte tests'
    )
    expect(nativeStep.if).toBe('!cancelled()')

    // Why a literal comparison: the spec cannot import the .mjs module, so the env var name is
    // written twice and would otherwise drift into a receipt nobody reads.
    const specSideReceipt = readFileSync(
      join(projectDir, 'tests/e2e/terminal-ime-engagement-receipt.ts'),
      'utf8'
    )
    expect(specSideReceipt).toContain(`'${IME_ENGAGEMENT_RECEIPT_ENV}'`)

    // Why pin the titles: the runner requires one receipt per name, so a rename that nobody
    // mirrored here would fail the lane loudly instead of quietly halving it.
    for (const title of EXPECTED_NATIVE_IME_TESTS) {
      expect(nativeImeSpec, title).toContain(title)
    }
  })

  it('keeps the native IME spec out of the lane that would silently skip it', () => {
    const changedRun = e2eWorkflow.jobs['changed-e2e'].steps.find(
      (step) => step.name === 'Run changed E2E specs'
    )
    expect(changedRun.run).toContain('. != "tests/e2e/terminal-ibus-hangul-native.spec.ts"')
    // Why it still has to be routed: the dedicated lane is selected by the same route, so the
    // spec appearing in test_files is how a spec-only edit reaches the real-IME lane at all.
    expect(selectPrE2eSpecs(['src/shared/terminal-unicode-provider.ts'])).toContain(
      'tests/e2e/terminal-ibus-hangul-native.spec.ts'
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
