import { DEDICATED_E2E_SPECS } from './ci-e2e-job-selection.mjs'
import { linuxInstallPackageList } from './pr-e2e-linux-packages.test-fixture.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  hasNativeImeSourceChange,
  hasSshSourceChange,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs,
  SSH_SOURCE_ROUTE_IDS
} from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
const e2eWorkflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))

const filterStep = prWorkflow.jobs.code_paths.steps.find(
  (step) => step.name === 'Filter changed E2E specs'
)
const rollbackStep = prWorkflow.jobs.preflight.steps.find(
  (step) => step.name === 'Check VM runtime rollback compatibility'
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

  it('maps SSH source edits onto the Docker-backed specs they can break', () => {
    // Why: the Docker-SSH specs self-skip without ORCA_E2E_SSH_DOCKER, and the only
    // trigger used to be "someone edited a spec" — four pane-restore regressions shipped
    // through that hole. Each mapped spec must exist, or the lane runs an empty file list.
    const sshSourceAuthorities = [
      'src/main/ssh/',
      'src/main/providers/ssh-',
      'src/main/ipc/pty',
      'src/relay/',
      'src/wsl-guest/',
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
    const install = e2eWorkflow.jobs['changed-e2e'].steps.find((step) =>
      step.name.startsWith('Install native build')
    )
    expect(linuxInstallPackageList(install, 'changed-e2e')).toMatch(/(^|\s)openssh-client(\s|$)/)
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
    expect(prWorkflow.jobs.code_paths.outputs.ssh_source_changed).toBe(
      '${{ steps.e2e_filter.outputs.ssh_source_changed }}'
    )
    expect(prWorkflow.jobs.e2e.with.ssh_source_changed).toBe(
      '${{ needs.code_paths.outputs.ssh_source_changed }}'
    )
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --ssh-source')
    expect(filterStep.run).toContain('ssh_source_changed=$SSH_SOURCE_CHANGED')
  })

  it('scopes the VM rollback oracle to the PR range and recipe schema authorities', () => {
    expect(rollbackStep.run).toMatch(/diff-base\.mjs "\$BASE_SHA"[\s\S]*"\$DIFF_BASE" HEAD --/)
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
      'src/main/ripgrep/bundled-ripgrep-path.ts',
      'src/shared/bundled-ripgrep.ts',
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

  it('keeps the native IME spec out of the lane that would silently skip it', () => {
    expect(DEDICATED_E2E_SPECS).toContain('tests/e2e/terminal-ibus-hangul-native.spec.ts')
    // Why it still has to be routed: the dedicated lane is selected by the same route, so the
    // spec appearing in test_files is how a spec-only edit reaches the real-IME lane at all.
    expect(selectPrE2eSpecs(['src/shared/terminal-unicode-provider.ts'])).toContain(
      'tests/e2e/terminal-ibus-hangul-native.spec.ts'
    )
  })
})
