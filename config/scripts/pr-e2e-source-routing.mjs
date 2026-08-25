import process from 'node:process'
import { pathToFileURL } from 'node:url'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file)

export const PR_E2E_SOURCE_ROUTES = [
  {
    id: 'ephemeral-vm-runtime.rollback-readable-sidecar',
    specs: ['tests/e2e/ephemeral-vm-provisioned-root.spec.ts'],
    matches: (file) =>
      /^(?:src\/main\/ephemeral-vm-(?:runtime-(?:service|provisioning-persistence)|failed-start-cleanup)|src\/shared\/(?:ephemeral-vm-runtime-(?:store|feature-store|rollback-projection|runtimes)|ephemeral-vm-recipes|orca-yaml-hook-types))\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh-terminal-source',
    specs: [
      'tests/e2e/pty-input-write-queue-ssh.spec.ts',
      'tests/e2e/ssh-cold-activation-restore.spec.ts',
      'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
      'tests/e2e/ssh-startup-exec-readiness.spec.ts',
      'tests/e2e/ssh-terminal-window-wake-stale-grid-repro.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/main\/ssh\/|src\/main\/providers\/ssh-|src\/main\/ipc\/(?:ssh-|pty)|src\/relay\/|src\/renderer\/src\/components\/terminal-pane\/(?:pty-|ssh-|remote-runtime-|terminal-parked-pty))/.test(
        file
      )
  },
  {
    id: 'terminal-input.ime-and-synthetic-forwarding',
    specs: [
      'tests/e2e/terminal-cjk-ime-committed-text.spec.ts',
      'tests/e2e/terminal-hangul-wrap-boundary-bytes.spec.ts',
      'tests/e2e/terminal-ime-exact-byte.spec.ts',
      'tests/e2e/terminal-korean-composing-chord-order.spec.ts',
      'tests/e2e/terminal-korean-endofrow-preedit-cell-span.spec.ts',
      'tests/e2e/terminal-korean-midline-preedit-occlusion.spec.ts',
      'tests/e2e/terminal-korean-preedit-visibility.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:config\/patches\/|src\/renderer\/src\/components\/terminal-pane\/(?:terminal-ime-|use-terminal-pane-lifecycle|xterm-bypass-policy|terminal-option-shortcut-policy))/.test(
        file
      )
  },
  {
    id: 'terminal-startup.quick-command-pre-bind-recovery',
    specs: ['tests/e2e/terminal-quick-command-pre-bind-recovery.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/tab-bar\/TabBarQuickCommandsMenu\.tsx|src\/renderer\/src\/hooks\/use-terminal-quick-command-hosts\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:pty-connection|pty-transport|terminal-pty-pre-spawn-e2e-barrier)\.ts|src\/renderer\/src\/components\/terminal-pane\/pty-connection\/(?:connect-pane-pty|fresh-spawn-start|pane-pty-visibility-bind|pty-input-recovery)\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:TerminalPane|use-terminal-pane-lifecycle)\.tsx?|src\/renderer\/src\/store\/slices\/terminals\.ts)$/.test(
        file
      )
  },
  {
    id: 'quick-open.paired-host-path-search',
    specs: ['tests/e2e/paired-quick-open-large-tree.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/main\/ipc\/(?:filesystem-(?:list-files|search-file-paths)|rg-availability)\.ts|src\/main\/providers\/(?:filesystem-provider-contract|ssh-filesystem-provider(?:-capabilities)?)\.ts|src\/main\/runtime\/(?:orca-runtime-files|rpc\/methods\/files)\.ts|src\/relay\/(?:fs-handler(?:-install-rg|-list-files|-ripgrep-fallback)?|fs-list-files-fallback-chain)\.ts|src\/renderer\/src\/(?:components\/(?:QuickOpen|quick-open-file-list|quick-open-search)\.tsx?|runtime\/(?:runtime-file-client|runtime-legacy-quick-open-inventory)\.ts)|src\/shared\/(?:quick-open-(?:install-rg|path-search|transport-budget)|ripgrep-process-availability)\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-session.host-cold-park-stream-continuity',
    specs: ['tests/e2e/host-parked-pane-remote-viewer.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:terminal-hidden-view-parking|terminal-tab-park-candidates|terminal-tab-activation-order|terminal-parked-pty-watcher|terminal-parked-tab-watchers|terminal-parked-watcher-registry)\.ts|src\/renderer\/src\/runtime\/sync-runtime-graph\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-provider.ssh-remote-reattach-contract',
    specs: ['tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      !file.endsWith('-test-harness.ts') &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/remote-runtime-pty-transport(?:-[a-z0-9-]+)?\.ts|src\/renderer\/src\/runtime\/remote-runtime-terminal-multiplexer\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-session.remote-pane-layout-retry',
    specs: ['tests/e2e/paired-remote-pane-layout-retry.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:remote-pane-layout-push|TerminalPane)\.tsx?|src\/renderer\/src\/lib\/terminal-layout-equality\.ts|src\/renderer\/src\/runtime\/web-session-tabs-sync\.ts|src\/renderer\/src\/store\/slices\/terminals\.ts)$/.test(
        file
      )
  },
  {
    // Why: the host's row for a client-rendered page only exists across two real Electron
    // apps, so this spec is the only gate on it. The high-churn seams it also rides
    // (ipc/runtime, useIpcEvents, preload) are left out deliberately: routing on those runs a
    // two-app e2e on most PRs, and their client-hosted share is already covered by the
    // main-process integration test.
    id: 'client-hosted-browser.host-strip',
    specs: ['tests/e2e/paired-client-hosted-browser-host-strip.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/.*(?:[Cc]lient-?[Hh]osted-?[Bb]rowser|BrowserPaneOverlayLayer)/.test(file)
  },
  {
    // Why a second, wider pattern: restart survival breaks from seams that never say
    // "client-hosted" - page adoption, the host lease/reconciliation plan, the session-tab
    // snapshot the client culls rows against. orca-runtime.ts is included despite its churn: it
    // publishes the snapshot flag the client holds its rows on, and no narrower path names that
    // seam.
    id: 'client-hosted-browser.restart-survival',
    specs: ['tests/e2e/paired-client-hosted-browser-restart-survival.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/.*(?:[Cc]lient-?[Hh]osted|browser-host-(?:lease|page|client-page)|browser-client-(?:host|page)|runtime-browser-(?:client-)?page|session-tabs-sync|host-session-snapshot-authority|orca-runtime(?:-browser)?\.ts|\/runtime-(?:status|types)\.ts)/.test(
        file
      )
  }
]

export function selectPrE2eSpecs(changedPaths, reportRoute = () => undefined) {
  const specs = new Set(changedPaths.filter((file) => /^tests\/e2e\/.*\.spec\.ts$/.test(file)))
  for (const route of PR_E2E_SOURCE_ROUTES) {
    const matchedFiles = changedPaths.filter(route.matches)
    if (matchedFiles.length === 0) {
      continue
    }
    route.specs.forEach((spec) => specs.add(spec))
    reportRoute(`[pr-e2e] ${route.id}: ${route.specs.join(', ')}`)
  }
  return [...specs].sort((left, right) => left.localeCompare(right))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  const changedPaths = input.split(/\r?\n/).filter(Boolean)
  const specs = selectPrE2eSpecs(changedPaths, (message) => console.error(message))
  process.stdout.write(`${JSON.stringify(specs)}\n`)
}
