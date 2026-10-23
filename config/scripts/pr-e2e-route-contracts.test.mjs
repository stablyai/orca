import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import {
  classifyE2eJobs,
  DEDICATED_E2E_SPECS,
  MANAGED_SSH_E2E_SPEC_PREFIX,
  ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
  WINDOWS_COPY_FILE_E2E_SPEC,
  WINDOWS_MISSING_APPDATA_E2E_SPEC,
  selectGeneralE2eSpecs
} from './ci-e2e-job-selection.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { testImportClosure } from './e2e-test-import-closure.mjs'
import { isLayoutOracleSource, LAYOUT_ORACLE_E2E_SPECS } from './pr-layout-oracle-route.mjs'
import {
  hasNativeImeSourceChange,
  MANUAL_ONLY_E2E_SPECS,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs,
  shouldRunReusablePrE2e
} from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
const e2eWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))

describe('pr-e2e-native-only-routing', () => {
  const workflow = prWorkflow
  const filterStep = workflow.jobs.code_paths.steps.find((step) => step.id === 'e2e_filter')

  describe('native-only PR E2E routing', () => {
    it('avoids generic E2E allocation for native-only changes while preserving its IME lane', () => {
      for (const file of [
        'tests/e2e/terminal-ibus-hangul-native.spec.ts',
        'config/scripts/run-terminal-ibus-hangul-e2e.mjs'
      ]) {
        expect(hasNativeImeSourceChange([file])).toBe(true)
        expect(shouldRunReusablePrE2e([file])).toBe(false)
      }
      expect(shouldRunReusablePrE2e([])).toBe(false)
      for (const spec of [
        'tests/e2e/paired-startup-exec-readiness.spec.ts',
        'tests/e2e/terminal-ime-exact-byte.spec.ts',
        'tests/e2e/future.spec.ts'
      ]) {
        expect(shouldRunReusablePrE2e([spec])).toBe(true)
        expect(
          shouldRunReusablePrE2e(['tests/e2e/terminal-ibus-hangul-native.spec.ts', spec])
        ).toBe(true)
      }
      expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --reusable-workflow')
      expect(filterStep.run).toContain('if [ "$SHOULD_RUN" = true ]; then')
    })
  })
})

describe('pr-e2e-pane-close-routing', () => {
  /**
   * The product paths of #21005, "retire captured remote handles when pending panes close". It
   * changed the pane close and retirement lifecycle across three transports and matched no route
   * at all, so it merged with E2E skipped outright. The routes named every module that BINDS a
   * pane and none that unbinds one.
   */
  const PENDING_PANE_CLOSE_CHANGE = [
    'src/renderer/src/components/terminal-pane/retire-unbound-ipc-terminal-pane.ts',
    'src/renderer/src/components/terminal-pane/retire-unbound-runtime-terminal-pane.ts',
    'src/renderer/src/components/terminal-pane/terminal-pane-close-admission.ts',
    'src/renderer/src/components/terminal-pane/terminal-pane-retirement-ownership.ts',
    'src/renderer/src/components/terminal-pane/use-terminal-pane-close-actions.ts',
    'src/renderer/src/store/terminals/terminal-tab-close-providers.ts'
  ]

  const CLOSE_ROUTE = PR_E2E_SOURCE_ROUTES.find(
    (route) => route.id === 'terminal-pane.close-and-retirement'
  )

  describe('pane close and retirement PR E2E routing', () => {
    it('selects the close specs for a pane close lifecycle change', () => {
      expect(selectPrE2eSpecs(PENDING_PANE_CLOSE_CHANGE)).toEqual([
        'tests/e2e/paired-remote-split-pane-host-retired-ghost.spec.ts',
        'tests/e2e/terminal-pane-close-layout-consistency.spec.ts',
        'tests/e2e/terminal-parked-close-retirement.spec.ts'
      ])
      expect(shouldRunReusablePrE2e(PENDING_PANE_CLOSE_CHANGE)).toBe(true)
    })

    it('routes each unbind authority on its own, not just as a group', () => {
      expect(CLOSE_ROUTE, 'the close route was renamed or removed').toBeDefined()
      // A single-file change is the shape that slipped through; assert per path rather than only
      // on the union, where one matching path would hide five that do not.
      for (const file of PENDING_PANE_CLOSE_CHANGE) {
        expect(selectPrE2eSpecs([file]), file).toEqual(CLOSE_ROUTE.specs.toSorted())
      }
    })

    it('keeps every routed spec and authority a real file', () => {
      for (const spec of CLOSE_ROUTE.specs) {
        expect(existsSync(join(projectDir, spec)), spec).toBe(true)
      }
      for (const file of PENDING_PANE_CLOSE_CHANGE) {
        expect(existsSync(join(projectDir, file)), file).toBe(true)
      }
    })

    it('leaves unrelated changes alone', () => {
      // Neighbours in the same directories that this route must not claim.
      for (const file of [
        'src/renderer/src/components/terminal-pane/CloseTerminalDialog.tsx',
        'src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts',
        'src/renderer/src/runtime/runtime-rpc-client.ts',
        'src/renderer/src/store/terminals/terminal-tab-close-providers.test.ts'
      ]) {
        expect(CLOSE_ROUTE.matches(file), file).toBe(false)
      }
    })
  })
})

describe('pr-e2e-layout-oracle-routing', () => {
  /** One product file per layout writer family; each alone must run the oracle. */
  const LAYOUT_AUTHORITIES = [
    'src/shared/workspace-layout/workspace-layout-pane-commands.ts',
    'src/shared/workspace-layout/old-client/old-client-session-tab-rows.ts',
    'src/main/persistence/terminal-topology/terminal-topology-commit.ts',
    'src/main/persistence/restoring-sessions/session-owner-fields.ts',
    'src/main/persistence/loading-store/pty-binding-persistence.ts',
    'src/main/remote-layout-snapshot/remote-layout-snapshot-recorder.ts',
    'src/main/runtime/terminal/launch/terminal-split-surface.ts',
    'src/main/runtime/terminal/adoption/adopt-terminal-orphans-from-inventory.ts',
    'src/main/runtime/runtime-terminal-orphan-adoption.ts',
    'src/main/runtime/session-tabs/headless-tab-group-moves.ts',
    'src/main/runtime/terminal/launch/terminal-create.ts',
    'src/main/runtime/terminal/stop/worktree-terminal-stop.ts',
    'src/renderer/src/runtime/mobile-session-tab-close.ts',
    'src/renderer/src/runtime/runtime-layout-client.ts',
    'src/renderer/src/store/slices/tabs.ts',
    'src/renderer/src/store/slices/tabs/tabs-move-actions.ts',
    'tests/e2e/workspace-layout-oracle-known-on-main.ts',
    'tests/e2e/helpers/workspace-layout-oracle-compare.ts',
    ...LAYOUT_ORACLE_E2E_SPECS
  ]

  /** Widened while the layout-holder stack is open: these still write layout. */
  const STACK_WRITERS = [
    'src/renderer/src/store/slices/terminals.ts',
    'src/renderer/src/components/terminal-pane/TerminalPane.tsx',
    'src/renderer/src/runtime/sync-runtime-graph.ts',
    'src/renderer/src/runtime/web-session-tabs-sync/store-patch.ts',
    'src/main/runtime/terminal/launch/terminal-split.ts',
    'src/main/runtime/workspaces/workspace-file-session-targets.ts',
    'src/main/runtime/session-graph/session-window-graph.ts',
    'src/main/runtime/session-tabs/mobile-session-hydration.ts',
    'src/main/runtime/session-tabs/mobile-session-reconciliation.ts',
    'src/main/runtime/session-tabs/mobile-session-preservation.ts',
    'src/main/runtime/workspaces/session-hosts/get-runtime-id.ts',
    'src/main/runtime/mobile-session-layout-projection.ts',
    'src/main/runtime/headless-runtime-graph.ts',
    'src/main/persistence/loading-store/session-host-partitions.ts',
    'src/main/persistence/loading-store/workspace-session-snapshot-publication.ts',
    'src/renderer/src/store/slices/tab-group-reference-repair.ts',
    'src/renderer/src/store/slices/terminal-session-row-hydration.ts',
    'src/renderer/src/store/workspace-layout-cache.ts',
    'src/renderer/src/app-shell/use-runtime-graph-sync.ts',
    'src/renderer/src/components/tab-group/tab-drag-drop-commit.ts',
    'src/shared/remote-layout-snapshot.ts',
    'src/shared/terminal-leaf-move.ts',
    'src/main/ipc/pty/ipc/leaf-move.ts',
    'src/main/persistence/closed-terminal-tab-write-fence.ts',
    'src/main/runtime/runtime-workspace-session-controller.ts',
    'src/main/runtime/workspaces/persisted-surfaces/has-exact-persisted-terminal-surface-identity.ts',
    'src/main/runtime/terminal-surface-close.ts',
    'src/main/runtime/terminal/output/terminal-derived-agent-facts.ts',
    'src/main/runtime/terminal/output/terminal-output-generation.ts',
    'src/main/runtime/session-tabs/mobile-session-membership.ts',
    'src/main/runtime/session-tabs/pty-backed-session-publication.ts',
    'src/renderer/src/components/terminal/terminal-tab-actions.ts',
    'src/renderer/src/components/tab-bar/web-runtime-tab-move-mirror.ts',
    'src/shared/rpc-contract/workspace-layout-params.ts',
    'src/renderer/src/store/slices/recently-closed-tabs.ts'
  ]

  /** Every test file the oracle specs import, transitively: a change there can break the gate. */
  const oracleHarnessFiles = () => testImportClosure(projectDir, LAYOUT_ORACLE_E2E_SPECS)

  describe('workspace layout oracle merge gate', () => {
    it('routes each layout authority and stack writer on its own', () => {
      for (const file of [...LAYOUT_AUTHORITIES, ...STACK_WRITERS]) {
        expect(isLayoutOracleSource(file), file).toBe(true)
        expect(classifyPrJobs([file]).layout_oracle, file).toBe(true)
        expect(existsSync(join(projectDir, file)), file).toBe(true)
      }
    })

    it('routes every test file the oracle specs import', () => {
      const harness = oracleHarnessFiles()
      expect(harness.length).toBeGreaterThan(LAYOUT_ORACLE_E2E_SPECS.length)
      expect(harness.filter((file) => !isLayoutOracleSource(file))).toEqual([])
    })

    it('leaves tests, fixtures, harnesses and unrelated runtime modules alone', () => {
      for (const file of [
        'src/main/persistence/terminal-topology/terminal-topology-commit.test.ts',
        'src/main/persistence/terminal-topology/terminal-leaf-move-fixture.ts',
        'src/main/runtime/orca-runtime-tests/mobile-session-tabs-part-03.spec.ts',
        'src/main/runtime/session-tabs/headless-tab-group-moves.test.ts',
        'src/main/runtime/session-tabs/headless-tab-group-moves-fixture.ts',
        'src/main/runtime/session-tabs/session-tabs-inventory-test-fixture.ts',
        'src/main/runtime/terminal/stop/worktree-terminal-stop.test.ts',
        'src/main/runtime/terminal/stop/worktree-terminal-stop-fixture.ts',
        'src/main/runtime/terminal/stop/worktree-terminal-stop.ts.backup',
        'src/main/runtime/terminal/stop/worktree-terminal-stop-extra.ts',
        'src/main/runtime/runtime-durable-store-fixture.ts',
        'src/main/runtime/orchestration/db/worker-terminal/worker-terminal-store.ts',
        'src/main/runtime/rpc/methods/terminal/terminal-create.ts',
        'src/main/runtime/runtime-rpc-database.ts',
        'src/main/runtime/orca-runtime-files.ts',
        'src/main/runtime/workspaces/persisted-surfaces/automation-operations.ts',
        'src/main/runtime/workspaces/persisted-surfaces/has-exact-persisted-terminal-surface-identity.test.ts',
        'src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts',
        'src/renderer/src/runtime/web-session-tabs-sync-test-harness.ts',
        'src/renderer/src/runtime/sync-runtime-graph-test-harness.ts',
        'src/renderer/src/runtime/sync-runtime-graph.test.ts',
        'tests/e2e/workspace-layout-oracle-latency.spec.ts'
      ]) {
        expect(isLayoutOracleSource(file), file).toBe(false)
      }
      expect(classifyPrJobs(['src/main/runtime/orca-runtime-files.ts']).layout_oracle).toBe(false)
    })

    it('keeps the oracle specs out of the advisory e2e job', () => {
      expect(selectPrE2eSpecs(LAYOUT_AUTHORITIES)).toEqual([])
      expect(shouldRunReusablePrE2e(LAYOUT_AUTHORITIES)).toBe(false)
    })

    it('runs exactly the oracle specs, each in the lane that can run it', () => {
      const job = prWorkflow.jobs.layout_oracle
      expect(job.uses).toBe('./.github/workflows/e2e.yml')
      // The merge commit, so a stale-base PR cannot pass on an old main.
      expect(job.with.ref).toBe('${{ github.sha }}')
      const specs = JSON.parse(job.with.test_files)
      expect(specs.toSorted()).toEqual(LAYOUT_ORACLE_E2E_SPECS.toSorted())
      // Window spec runs in the changed-spec lane; headless runs in the orcad lane.
      expect(selectGeneralE2eSpecs(specs)).toEqual(['tests/e2e/workspace-layout-oracle.spec.ts'])
      expect(classifyE2eJobs(job.with.test_files)).toEqual({
        e2e_run_changed: true,
        e2e_needs_build: true
      })
    })

    it('blocks the merge on the oracle and passes when it is skipped', () => {
      const verify = prWorkflow.jobs.verify
      const gate = verify.steps.find((step) => step.name === 'Require successful checks')
      expect(verify.needs).toContain('layout_oracle')
      expect(gate.run).toContain(
        'check_job layout_oracle "$LAYOUT_ORACLE" "$LAYOUT_ORACLE_SHOULD_RUN"'
      )
      // Two calls of the reusable workflow in one run must not share artifact names.
      expect(prWorkflow.jobs.layout_oracle.with.artifact_suffix).toBeTruthy()
      expect(prWorkflow.jobs.e2e.with.artifact_suffix).toBeUndefined()
    })
  })
})

describe('ssh-browser-e2e-routing', () => {
  const workflow = e2eWorkflow

  it('executes both Docker network routes in a Node job with their opt-in enabled', () => {
    const spec = 'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'
    const job = workflow.jobs['ssh-browser-network-route']
    const install = job.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const run = job.steps.find(
      (step) => step.name === 'Run Docker SSH browser network route journeys'
    )
    expect(job['runs-on']).toBe('blacksmith-4vcpu-ubuntu-2404')
    expect(job.if).toContain("inputs.test_files == ''")
    expect(job.if).toContain(spec)
    expect(install.with['native-runtime']).toBe('node')
    expect(run.env.ORCA_RUN_DOCKER_SSH_BROWSER_E2E).toBe('1')
    expect(run.run).toContain(`vitest run --config config/vitest.config.ts ${spec}`)
    expect(run['continue-on-error']).toBeUndefined()
    expect(DEDICATED_E2E_SPECS).toContain(spec)
    for (const changed of [
      spec,
      'src/main/browser/ssh-browser-network-execution-route.ts',
      'src/main/browser/browser-network-deferred-socket.ts',
      'src/main/browser/browser-network-execution-route.ts',
      'src/main/browser/system-ssh-socks-client-socket.ts',
      'src/main/ssh/system-transport/system-ssh-dynamic-forward-process.ts',
      'tests/e2e/helpers/docker-ssh-host-target.ts',
      'tests/e2e/helpers/docker-ssh-host-image.ts'
    ]) {
      expect(selectPrE2eSpecs([changed])).toContain(spec)
    }
    expect(selectPrE2eSpecs(['src/renderer/src/components/Unrelated.tsx'])).not.toContain(spec)
    expect(selectPrE2eSpecs(['tests/e2e/helpers/docker-ssh-host-terminal-tabs.ts'])).not.toContain(
      spec
    )
  })
})

describe('orcad-e2e-routing', () => {
  const root = projectDir
  const jobs = e2eWorkflow.jobs
  const ORCAD_AUTO_CONVERT_E2E_SPEC = 'tests/e2e/ssh-orcad-auto-convert.spec.ts'
  const ORCAD_IDLE_EXIT_E2E_SPEC = 'tests/e2e/ssh-orcad-idle-exit.spec.ts'
  const ORCAD_OPEN_IN_OWNER_E2E_SPEC = 'tests/e2e/ssh-orcad-open-in-owner.spec.ts'
  const ORCAD_JOURNEY_E2E_SPECS = [
    'tests/e2e/ssh-orcad-terminal-journeys.spec.ts',
    'tests/e2e/ssh-orcad-workspace-tools.spec.ts',
    'tests/e2e/ssh-orcad-vm-provisioned-root.spec.ts'
  ]

  function expectRouted(files, spec) {
    for (const file of files) {
      expect(existsSync(resolve(root, file)), file).toBe(true)
      expect(selectPrE2eSpecs([file]), file).toContain(spec)
      expect(shouldRunReusablePrE2e([file]), file).toBe(true)
    }
  }

  it('routes the mode-switch spec from its serve sources and harness', () => {
    expectRouted(
      [
        'src/main/orcad/orcad-lifecycle.ts',
        'src/main/daemon/daemon-spawner.ts',
        'tests/e2e/helpers/orca-serve-cli-host.ts',
        'tests/e2e/helpers/headless-paired-runtime-host.ts'
      ],
      ORCAD_SERVE_MODE_SWITCH_E2E_SPEC
    )
  })

  it('routes the missing-AppData spec from its startup sources and harness', () => {
    expectRouted(
      ['src/main/startup/windows-app-data-path.ts', 'tests/e2e/helpers/orca-serve-cli-host.ts'],
      WINDOWS_MISSING_APPDATA_E2E_SPEC
    )
  })

  it('routes the Windows file-copy spec from its clipboard sources', () => {
    expectRouted(
      [
        'src/main/window/clipboard-file-copy.ts',
        'src/main/window/clipboard-ipc-handlers.ts',
        'src/renderer/src/components/right-sidebar/file-explorer-row-file-transfer.ts'
      ],
      WINDOWS_COPY_FILE_E2E_SPEC
    )
  })

  it('routes the auto-convert spec from its conversion sources and harness', () => {
    expectRouted(
      [
        'src/main/managed-server/lifecycle/orcad-runtime-conversion.ts',
        'tests/e2e/helpers/orcad-convert-flow.ts',
        'tests/e2e/helpers/orcad-convert-host.ts',
        'tests/e2e/helpers/orcad-template-variant.ts',
        'tests/e2e/helpers/orcad-upgrade-profile.ts'
      ],
      ORCAD_AUTO_CONVERT_E2E_SPEC
    )
    expect(
      selectPrE2eSpecs(['src/main/managed-server/lifecycle/orcad-runtime-conversion.test.ts'])
    ).not.toContain(ORCAD_AUTO_CONVERT_E2E_SPEC)
  })

  it('routes the idle-exit spec from its idle sources and the shared convert harness', () => {
    expectRouted(
      [
        'src/shared/orcad-idle-exit.ts',
        'src/main/managed-server/install/orcad-remote-runtime-control.ts',
        'src/main/managed-server/lifecycle/orcad-managed-serving.ts',
        'tests/e2e/helpers/orcad-convert-flow.ts',
        'tests/e2e/helpers/orcad-convert-host.ts'
      ],
      ORCAD_IDLE_EXIT_E2E_SPEC
    )
  })

  it('builds the e2e app when only a build-dependent orcad spec is requested', () => {
    for (const spec of [
      ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
      ORCAD_AUTO_CONVERT_E2E_SPEC,
      ORCAD_IDLE_EXIT_E2E_SPEC,
      ORCAD_OPEN_IN_OWNER_E2E_SPEC
    ]) {
      expect(classifyE2eJobs(JSON.stringify([spec])), spec).toEqual({
        e2e_run_changed: false,
        e2e_needs_build: true
      })
    }
    expect(jobs['orcad-ssh-docker'].needs).toEqual(['build'])
  })

  it('passes the requested managed-SSH specs to the sharded lane', () => {
    const lane = jobs['orcad-ssh-docker']
    expect(lane.if).toBe(
      `inputs.test_files == '' || contains(inputs.test_files, '${MANAGED_SSH_E2E_SPEC_PREFIX}')`
    )
    expect(lane.strategy.matrix.shard).toBe(
      `\${{ fromJSON(inputs.managed_ssh_shards || '["1/2","2/2"]') }}`
    )
    const run = lane.steps.find((step) => step.env?.ORCA_E2E_SSH_DOCKER === '1').run
    expect(run).toContain('"${TEST_FILES[@]}"')
    expect(run).toContain('--shard="$SHARD"')
    for (const spec of [
      ORCAD_AUTO_CONVERT_E2E_SPEC,
      ORCAD_IDLE_EXIT_E2E_SPEC,
      ORCAD_OPEN_IN_OWNER_E2E_SPEC,
      ...ORCAD_JOURNEY_E2E_SPECS
    ]) {
      expect(existsSync(resolve(root, spec)), spec).toBe(true)
      expect(spec.startsWith(MANAGED_SSH_E2E_SPEC_PREFIX), spec).toBe(true)
    }
  })

  it('runs the Windows-only specs on one runner, each only when requested', () => {
    expect(jobs['windows-missing-appdata-startup']).toBeUndefined()
    const job = jobs['orcad-serve-mode-switch-windows']
    for (const spec of [
      ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
      WINDOWS_MISSING_APPDATA_E2E_SPEC,
      WINDOWS_COPY_FILE_E2E_SPEC
    ]) {
      expect(job.if, spec).toContain(`contains(inputs.test_files, '${spec}')`)
      const step = job.steps.find((candidate) => candidate.run?.includes(spec))
      expect(step.if, spec).toContain(`contains(inputs.test_files, '${spec}')`)
      expect(step.env.ORCA_STARTUP_DIAGNOSTICS, spec).toBeUndefined()
    }
  })

  it('routes managed target-owner guards and menus to the real launch regression', () => {
    expectRouted(
      [
        'src/renderer/src/lib/local-path-open-guard.ts',
        'src/renderer/src/lib/external-editor-open-capability.ts',
        'src/renderer/src/lib/worktree-runtime-owner.ts',
        'src/renderer/src/components/sidebar/WorktreeOpenInMenu.tsx',
        'src/renderer/src/components/sidebar/WorktreeContextMenuView.tsx',
        'src/renderer/src/components/right-sidebar/FileExplorer.tsx',
        'src/renderer/src/components/right-sidebar/FileExplorerToolbar.tsx',
        'src/renderer/src/components/right-sidebar/source-control/listing/entry-context-menu.tsx',
        'tests/e2e/helpers/orcad-convert-flow.ts',
        'tests/e2e/helpers/orcad-convert-host.ts',
        'tests/e2e/helpers/orcad-upgrade-profile.ts',
        'tests/e2e/helpers/docker-ssh-host-target.ts'
      ],
      ORCAD_OPEN_IN_OWNER_E2E_SPEC
    )
    expect(selectPrE2eSpecs(['src/renderer/src/lib/local-path-open-guard.test.ts'])).not.toContain(
      ORCAD_OPEN_IN_OWNER_E2E_SPEC
    )
  })

  it('routes the managed-host journey specs from their harness and sources', () => {
    for (const spec of ORCAD_JOURNEY_E2E_SPECS) {
      expectRouted(
        [
          'tests/e2e/helpers/orcad-managed-workspace.ts',
          'src/renderer/src/components/terminal-pane/terminal-host-workspace-file.ts',
          'src/renderer/src/components/terminal-pane/terminal-host-file-link-existence.ts',
          'src/renderer/src/runtime/runtime-terminal-artifact-read.ts',
          // #30130's Disconnect sources merged with this lane skipped.
          'src/main/ipc/ssh/ssh-host-user-disconnect.ts',
          'src/main/ipc/ssh/ssh-connect-flow.ts',
          'src/main/ipc/ssh/ssh-connection-handlers.ts',
          'src/main/ipc/runtime-environments/runtime-environment-connectivity-handlers.ts',
          'src/main/ipc/runtime-environments/runtime-environment-manual-disconnect.ts',
          'src/main/ssh/connection/ssh-connection-manager.ts',
          'src/main/ssh/ssh-user-disconnect.ts',
          'src/renderer/src/runtime/web-session-close-intent.ts',
          'src/renderer/src/runtime/web-session-close-replay.ts'
        ],
        spec
      )
      expect(classifyE2eJobs(JSON.stringify([spec])), spec).toEqual({
        e2e_run_changed: false,
        e2e_needs_build: true
      })
    }
  })
})

function selectsManagedSshLane(file) {
  return selectPrE2eSpecs([file]).some((spec) => spec.startsWith(MANAGED_SSH_E2E_SPEC_PREFIX))
}

describe('managed-SSH remote sources routing', () => {
  it('gives every managed-SSH spec a source route', () => {
    const routed = new Set(PR_E2E_SOURCE_ROUTES.flatMap((route) => route.specs))
    const specs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((name) => /^ssh-orcad-.*\.spec\.ts$/.test(name))
      .map((name) => `tests/e2e/${name}`)
    expect(specs.length).toBeGreaterThan(0)
    expect(
      specs.filter((spec) => !routed.has(spec) && !MANUAL_ONLY_E2E_SPECS.includes(spec))
    ).toEqual([])
  })

  it('starts the lane for remote product sources no hand-kept route names', () => {
    for (const file of [
      // #30130 and #30120 merged with the lane skipped.
      'src/main/ipc/ssh/ssh.ts',
      'src/cli/runtime/serve-orcad-launch.ts',
      'src/main/orcad/orcad-entry.ts',
      'src/main/ssh/connection/ssh-connection.ts',
      'src/main/ipc/runtime-environments/runtime-environment-status-probe.ts',
      'src/main/ipc/runtime-environments/orcad-runtime-lifecycle-handlers.ts',
      'src/shared/protocol-version.ts',
      'src/shared/remote-runtime-client-error-classification.ts',
      // #30047 and #30060: sidebar sleep and project removal.
      'src/renderer/src/components/sidebar/sleep-worktree-flow.ts',
      'src/renderer/src/components/sidebar/ssh-host-remove-resolution.ts',
      'src/renderer/src/store/repos/repo-removal.ts',
      // #30775: the pane banner for a managed server that refused this desktop.
      'src/renderer/src/components/terminal-pane/TerminalRemoteRuntimeReconnectBanner.tsx',
      'src/renderer/src/components/terminal-pane/use-managed-pairing-refused.ts',
      'src/renderer/src/components/terminal-pane/TerminalPaneRuntimePortals.tsx'
    ]) {
      expect(existsSync(join(projectDir, file)), file).toBe(true)
      expect(selectsManagedSshLane(file), file).toBe(true)
    }
  })

  it('leaves unit tests and local-only sources alone', () => {
    for (const file of [
      'src/main/ssh/connection/ssh-connection.test.ts',
      'src/main/ipc/ssh/ssh.test.ts',
      'src/main/daemon/daemon-server.ts',
      'src/main/runtime/rpc/methods/accounts.ts',
      'src/renderer/src/components/sidebar/WorktreeCard.tsx',
      'src/renderer/src/store/repos/repo-ordering.ts',
      'docs/STYLEGUIDE.md'
    ]) {
      expect(selectsManagedSshLane(file), file).toBe(false)
    }
  })
})
