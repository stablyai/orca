import process from 'node:process'
import { pathToFileURL } from 'node:url'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file)

// Why config/patches: the xterm fork owns the helper textarea an input method attaches to, so a
// patch edit can break composition without touching a file named "ime".
const NATIVE_IME_PRODUCT_SOURCE =
  /^(?:config\/patches\/|src\/shared\/terminal-unicode-provider\.ts$|src\/renderer\/src\/lib\/pane-manager\/terminal-ime-|src\/renderer\/src\/components\/terminal-pane\/(?:terminal-ime-|terminal-ios-hangul-|xterm-bypass-policy))/

/** The harness itself: the session runner, the boundary probes, and the native specs. */
const NATIVE_IME_HARNESS =
  /^(?:config\/scripts\/(?:run-terminal-ibus-hangul-e2e|terminal-ime-engagement-receipt)\.mjs$|tests\/e2e\/terminal-ime-(?:boundary-probe|byte-reader|engagement-receipt)\.ts$|tests\/e2e\/terminal-(?:ibus-hangul|hangul-terminating-digit|macos-2set-korean)-native\.spec\.ts$)/

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
      'tests/e2e/ssh-docker-half-open-link.spec.ts',
      'tests/e2e/ssh-docker-reconnect-pane-restore.spec.ts',
      'tests/e2e/ssh-docker-resource-accumulation.spec.ts',
      'tests/e2e/ssh-docker-transport-drop-recovery.spec.ts',
      'tests/e2e/ssh-port-forward-lifecycle.spec.ts',
      'tests/e2e/ssh-reconnect-tab-destruction.spec.ts',
      'tests/e2e/ssh-startup-exec-readiness.spec.ts',
      'tests/e2e/ssh-terminal-window-wake-stale-grid-repro.spec.ts'
    ],
    // Why the store/startup/shared additions: the SSH-named authorities stop at the main
    // process and the pane component, but the reconnect ledgers and retained-payload
    // admission that decide whether a pane rebinds live in the renderer store.
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/main\/ssh\/|src\/main\/providers\/ssh-|src\/main\/ipc\/(?:ssh-|pty)|src\/main\/runtime\/(?:public-ssh-state|ssh-file-explorer-chunk-read)\.ts|src\/relay\/|src\/shared\/(?:ssh-|skill-ssh-relay-contract)|src\/renderer\/src\/startup\/(?:ssh-startup-reconnect|startup-ssh-connection-restore)\.ts|src\/renderer\/src\/store\/slices\/(?:ssh|direct-ssh-)|src\/renderer\/src\/components\/terminal-pane\/(?:pty-|ssh-|remote-runtime-|terminal-parked-pty))/.test(
        file
      )
  },
  {
    // Why a sibling route rather than more paths on ssh-terminal-source: these modules carry
    // no "ssh" in their names, and only the two restore specs gate them. Folding them in
    // would run the whole SSH terminal list for a tab-tombstone edit.
    id: 'ssh-workspace-session-restore',
    specs: [
      'tests/e2e/ssh-cold-activation-restore.spec.ts',
      'tests/e2e/ssh-reconnect-tab-destruction.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      !file.endsWith('-test-harness.ts') &&
      /^(?:src\/main\/ipc\/remote-workspace|src\/shared\/remote-workspace-|src\/renderer\/src\/hooks\/remote-workspace-|src\/renderer\/src\/lib\/worktree-(?:initial-terminal-seeding|default-terminal-tabs)\.ts|src\/renderer\/src\/components\/terminal\/initial-terminal)/.test(
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
    // Why a route beside terminal-input.ime-and-synthetic-forwarding rather than more specs on
    // it: that route selects the CDP-synthetic specs, which drive composition through
    // Input.imeSetComposition and so prove Orca's handling without an input method existing.
    // This one names the surface only a real ibus-hangul session can judge, and is the sole
    // trigger that puts the real-IME lane on a PR.
    id: 'terminal-ime.native-input-method',
    specs: ['tests/e2e/terminal-ibus-hangul-native.spec.ts'],
    matches: (file) =>
      (isProductSource(file) && NATIVE_IME_PRODUCT_SOURCE.test(file)) ||
      NATIVE_IME_HARNESS.test(file)
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
    id: 'terminal-session.parked-cli-split',
    specs: ['tests/e2e/terminal-parked-cli-split.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/main\/window\/attach-main-window-services\.ts|src\/preload\/(?:index|api\/ui-command-event-api)\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:terminal-pane-split-request-routing|use-terminal-pane-lifecycle|use-terminal-tab-cold-parking)\.ts|src\/renderer\/src\/hooks\/ipc-events\/terminal-ui-routing-ipc-bridge\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-session.paired-serve-restart-binding-continuity',
    specs: ['tests/e2e/paired-remote-terminal-serve-restart-binding.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/main\/daemon\/(?:daemon-attach-only-retirement|daemon-pty-applied-size|daemon-pty-session-control|daemon-pty-spawn-result)\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:remote-runtime-pty-transport|terminal-error-accumulation)\.ts|src\/renderer\/src\/runtime\/(?:web-runtime-session|web-session-tabs-sync|web-session-terminal-orphan-(?:topology|recovery(?:-(?:adoption|surface|inventory|inventory-validation|cache|queue|rpc-lane|pane))?))\.ts)$/.test(
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

/** Routes whose authorities are SSH execution source, and so require the Docker-SSH lane. */
export const SSH_SOURCE_ROUTE_IDS = ['ssh-terminal-source', 'ssh-workspace-session-restore']

// Why derive this from the routes instead of a second path list: the Docker-SSH lane used to
// trigger only because one route happened to list a startup-readiness spec, so pruning that
// spec would have silently retired the lane. Two lists that must agree is how that drifted.
export function hasSshSourceChange(changedPaths) {
  return PR_E2E_SOURCE_ROUTES.filter((route) => SSH_SOURCE_ROUTE_IDS.includes(route.id)).some(
    (route) => changedPaths.some(route.matches)
  )
}

/** Routes whose authorities a real input method can judge, and so require the native IME lane. */
export const NATIVE_IME_SOURCE_ROUTE_IDS = ['terminal-ime.native-input-method']

// Why derived from the routes, like hasSshSourceChange: the native lane must trigger on IME
// source, not on the native spec surviving in some route's spec list.
export function hasNativeImeSourceChange(changedPaths) {
  return PR_E2E_SOURCE_ROUTES.filter((route) =>
    NATIVE_IME_SOURCE_ROUTE_IDS.includes(route.id)
  ).some((route) => changedPaths.some(route.matches))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  const changedPaths = input.split(/\r?\n/).filter(Boolean)
  if (process.argv.includes('--ssh-source')) {
    process.stdout.write(`${hasSshSourceChange(changedPaths)}\n`)
  } else if (process.argv.includes('--native-ime-source')) {
    process.stdout.write(`${hasNativeImeSourceChange(changedPaths)}\n`)
  } else {
    const specs = selectPrE2eSpecs(changedPaths, (message) => console.error(message))
    process.stdout.write(`${JSON.stringify(specs)}\n`)
  }
}
