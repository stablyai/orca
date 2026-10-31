// Paths whose change runs the required `layout_oracle` job in pr.yml.

/** The layout oracle's two specs; the job runs both and nothing else. */
export const LAYOUT_ORACLE_E2E_SPECS = [
  'tests/e2e/workspace-layout-oracle-headless.spec.ts',
  'tests/e2e/workspace-layout-oracle.spec.ts'
]

const LAYOUT_ORACLE_PREFIXES = [
  // Layout model, persistence and compatibility folders.
  'src/shared/workspace-layout/',
  'src/shared/remote-layout-snapshot.ts',
  'src/shared/terminal-leaf-move.ts',
  'src/main/persistence/terminal-topology/',
  'src/main/persistence/restoring-sessions/',
  'src/main/persistence/loading-store/pty-binding-',
  'src/main/persistence/loading-store/session-host-partitions.ts',
  'src/main/persistence/loading-store/workspace-session-snapshot-publication.ts',
  'src/main/remote-layout-snapshot/',
  'src/main/runtime/old-session-tabs-stream/',
  'src/renderer/src/runtime/remote-workspace-frozen/',
  // Window-side layout writers the layout-holder stack replaces; widened while it is open.
  'src/renderer/src/store/slices/tabs',
  'src/renderer/src/store/slices/tab-group',
  'src/renderer/src/store/slices/terminals',
  'src/renderer/src/store/slices/terminal-',
  'src/renderer/src/store/terminals/',
  'src/renderer/src/store/workspace-layout-cache',
  'src/renderer/src/components/terminal-pane/',
  'src/renderer/src/components/tab-group/tab-drag-drop-commit.ts',
  'src/renderer/src/app-shell/use-runtime-graph-sync.ts',
  'src/renderer/src/runtime/sync-runtime-graph',
  'src/renderer/src/runtime/web-session-tabs-sync',
  // Other layout writers the stack edits.
  'src/main/ipc/pty/ipc/leaf-move.ts',
  'src/main/persistence/closed-terminal-tab-write-fence.ts',
  'src/main/runtime/runtime-workspace-session-controller.ts',
  'src/main/runtime/terminal-surface-close.ts',
  'src/main/runtime/terminal/output/terminal-derived-agent-facts.ts',
  'src/main/runtime/terminal/output/terminal-output-generation.ts',
  'src/main/runtime/session-graph/session-window-graph.ts',
  'src/main/runtime/session-tabs/mobile-session-hydration.ts',
  'src/main/runtime/session-tabs/mobile-session-reconciliation.ts',
  'src/main/runtime/session-tabs/mobile-session-preservation.ts',
  'src/main/runtime/workspaces/session-hosts/get-runtime-id.ts',
  'src/renderer/src/components/terminal/terminal-tab-actions.ts',
  'src/renderer/src/components/tab-bar/web-runtime-tab-move-mirror.ts',
  'src/shared/rpc-contract/workspace-layout-params.ts',
  'src/renderer/src/store/slices/recently-closed-tabs.ts',
  // The client the oracle reads every view through.
  'src/cli/runtime/client.ts',
  'src/shared/remote-runtime/remote-runtime-client.ts',
  'src/shared/remote-runtime/requests/remote-runtime-subscription-transport.ts',
  'src/shared/paired-runtime-connection.ts',
  'src/shared/pairing.ts',
  // The harness: the oracle imports most of the shared e2e helpers, not just its own.
  'tests/e2e/workspace-layout-oracle',
  'tests/e2e/terminal-probe-input-sequence.ts',
  'tests/e2e/global-',
  'tests/e2e/helpers/',
  'tests/playwright.config.ts',
  '.github/scripts/e2e-with-window-manager.sh',
  // The job itself: the called workflow, its window-spec lane picker, and this route.
  '.github/workflows/e2e.yml',
  '.github/scripts/prepare-ubuntu-apt.sh',
  'config/scripts/ci-e2e-job-selection.mjs',
  'config/scripts/pr-layout-oracle-route.mjs'
]

const RUNTIME_LAYOUT_WRITERS = [
  'src/main/runtime/terminal/launch/terminal-create.ts',
  'src/main/runtime/terminal/launch/terminal-split.ts',
  'src/main/runtime/terminal/launch/terminal-split-surface.ts',
  'src/main/runtime/terminal/stop/worktree-terminal-stop.ts',
  'src/main/runtime/workspaces/workspace-file-session-targets.ts',
  'src/main/runtime/workspaces/persisted-surfaces/has-exact-persisted-terminal-surface-identity.ts',
  'src/main/runtime/runtime-terminal-orphan-adoption.ts',
  'src/main/runtime/terminal/adoption/adopt-terminal-orphans-from-inventory.ts',
  'src/main/runtime/session-tabs/mobile-session-membership.ts',
  'src/main/runtime/session-tabs/pty-backed-session-publication.ts'
]

// Runtime matches only the modules that create, move, close, persist or publish layout.
const LAYOUT_ORACLE_RUNTIME_MODULE =
  /^src\/(?:main|renderer\/src)\/runtime\/(?:[^/]+\/)*[^/]*(?:pane-admission|workspace-layout|session-tab|headless-[^/]*tab|layout-client|layout-command-router|layout-projection|create-terminal|split-terminal|split-pty-backed-terminal|terminal-split-layout|spawn-placement|sync-window-graph|runtime-graph|leaf-move)[^/]*\.ts$/

// Why fixtures only under src/: there they serve unit tests; e2e fixtures are the oracle's harness.
const TEST_SUPPORT =
  /\.(?:test|spec)\.(?:[cm]?js|tsx?)$|\/__tests__\/|^src\/.*-fixtures?\.ts$|-test-harness\.tsx?$/

export function isLayoutOracleSource(file) {
  if (LAYOUT_ORACLE_E2E_SPECS.includes(file)) {
    return true
  }
  if (TEST_SUPPORT.test(file)) {
    return false
  }
  return (
    RUNTIME_LAYOUT_WRITERS.includes(file) ||
    LAYOUT_ORACLE_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    LAYOUT_ORACLE_RUNTIME_MODULE.test(file)
  )
}
