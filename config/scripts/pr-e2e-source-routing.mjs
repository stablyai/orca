import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  DAEMON_INIT_TEST_SUPPORT,
  isDaemonInitTestSupportChange,
  isUnitTestSupportSource
} from './pr-code-change-scope.mjs'
import { LAYOUT_ORACLE_E2E_SPECS } from './pr-layout-oracle-route.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

// The core xterm patch owns the helper textarea an input method attaches to.
const XTERM_CORE_PATCH =
  /^config\/patches\/(?:@xterm__xterm@[^/]+\.patch|xterm-src\/@xterm__xterm@[^/]+\.src\.patch)$/

const NATIVE_IME_PRODUCT_SOURCE =
  /^(?:src\/shared\/terminal-unicode-provider\.ts$|src\/renderer\/src\/lib\/pane-manager\/terminal-ime-|src\/renderer\/src\/components\/terminal-pane\/(?:terminal-ime-|terminal-ios-hangul-|xterm-bypass-policy))/

/** The harness itself: the session runner, the boundary probes, and the native specs. */
const NATIVE_IME_HARNESS =
  /^(?:config\/scripts\/focus-nested-wayland-terminal\.sh$|config\/scripts\/(?:run-terminal-ibus-hangul-e2e|terminal-ime-engagement-receipt)\.mjs$|tests\/e2e\/terminal-ime-(?:boundary-probe|byte-reader|engagement-receipt)\.ts$|tests\/e2e\/terminal-(?:ibus-hangul|hangul-terminating-digit|macos-2set-korean)-native\.spec\.ts$)/

/**
 * Managed-SSH harness helpers; every managed-SSH spec runs in one job, so any route may claim them.
 * `pr-e2e-managed-ssh-harness-route.test.mjs` fails when a helper only these specs import is missing.
 */
const MANAGED_SSH_HARNESS =
  /^tests\/e2e\/helpers\/(?:orcad-managed-workspace|orcad-convert-(?:flow|host|teardown)|orcad-template-variant|orcad-upgrade-(?:profile|retained-state)|docker-ssh-host-target|reserve-local-port|ssh-remote-only-browser-fixture|windows-host-orcad-processes)\.ts$/

export const PR_E2E_SOURCE_ROUTES = [
  {
    id: 'ssh.orcad-editor-ownership',
    specs: ['tests/e2e/ssh-orcad-editor-ownership.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/runtime\/(?:web-session-existing-tab-index|web-session-tabs-sync\/(?:mirrored-editor-file-identity|tab-builders|apply-preparation-browser|state-equality-files|terminal-surfaces))\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-markdown-conversion',
    specs: ['tests/e2e/ssh-orcad-markdown-conversion.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/components\/editor\/(?:useMarkdownDocuments|restored-editor-workspace-runtime-owner|migrate-restored-editor-file-owner)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-markdown-link-refresh',
    specs: ['tests/e2e/ssh-orcad-markdown-link-refresh.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/components\/editor\/(?:rich-markdown-doc-link|useRichMarkdownProgrammaticSync)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-markdown-live-documents',
    specs: ['tests/e2e/ssh-orcad-markdown-live-documents.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/components\/editor\/(?:useMarkdownDocuments|use-markdown-document-watch-refresh|markdown-document-list-request)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-explorer-watch-recovery',
    specs: ['tests/e2e/ssh-orcad-explorer-watch-recovery.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      (file === 'src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts' ||
        file === 'src/renderer/src/hooks/worktree-file-change-event.ts')
  },
  {
    id: 'ssh.orcad-editor-watch-recovery',
    specs: ['tests/e2e/ssh-orcad-editor-watch-recovery.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/hooks\/(?:useEditorExternalWatch|editor-runtime-file-watch)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-explorer-selected-host',
    specs: ['tests/e2e/ssh-orcad-explorer-selected-host.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      (file === 'src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts' ||
        file === 'src/renderer/src/components/right-sidebar/file-explorer-operation-owner.ts' ||
        file === 'src/renderer/src/components/right-sidebar/FileExplorer.tsx' ||
        file === 'src/renderer/src/hooks/editor-external-watch-targets.ts' ||
        file === 'src/renderer/src/components/right-sidebar/useFileExplorerTree.ts' ||
        file === 'src/renderer/src/components/right-sidebar/use-file-explorer-tree-load-effects.ts')
  },
  {
    id: 'serve.orcad-mode-switch',
    specs: ['tests/e2e/orcad-serve-mode-switch.spec.ts'],
    matches: (file) =>
      /^tests\/e2e\/helpers\/(?:orca-serve-cli-host|headless-paired-runtime-host)\.ts$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /^src\/(?:cli\/runtime\/(?:launch|serve-)|main\/orcad\/(?:main|orcad-entry|orcad-instance-lock|orcad-command-arguments|orcad-lifecycle)\.ts$|main\/startup\/desktop-profile-instance-lock\.ts$|main\/daemon\/daemon-(?:spawner|endpoint-adoption|init)|main\/server\/serve-)/.test(
          file
        ))
  },
  {
    id: 'startup.windows-missing-appdata',
    specs: ['tests/e2e/windows-missing-appdata-startup.spec.ts'],
    matches: (file) =>
      file === 'tests/e2e/helpers/orca-serve-cli-host.ts' ||
      (isProductSource(file) &&
        /^src\/main\/startup\/(?:windows-app-data-path|main-process-preflight)\.ts$/.test(file))
  },
  {
    id: 'clipboard.windows-copy-file',
    specs: ['tests/e2e/file-explorer-copy-file-windows.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/window\/clipboard-(?:file-copy|ipc-handlers)|renderer\/src\/components\/right-sidebar\/file-explorer-row-file-transfer)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-auto-convert',
    specs: ['tests/e2e/ssh-orcad-auto-convert.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/main\/(?:ipc\/(?:ssh\/)?ssh-host-server-|(?:ssh|managed-server\/[a-z-]+)\/(?:ssh-host-server-|orcad-runtime-conversion|orcad-migration-|orcad-retained-source|orcad-runtime-deployment))/.test(
          file
        ))
  },
  // COMPAT(legacy-relay-bridge): revisit 2027-01-15 with src/main/ssh/legacy-relay/.
  {
    id: 'ssh.orcad-legacy-relay-bridge',
    specs: ['tests/e2e/ssh-orcad-legacy-relay-bridge.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      /^tests\/e2e\/(?:helpers\/(?:legacy-relay-docker-host|build-released-relay-bundle)|cross-version-wire\/released-relay-(?:daemon|transport))\.m?ts$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /(?:legacy-relay(?:-bridge|\/)|orcad-migration-terminal-gate|ssh-host-relay-terminals-on-connect)/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-browser-capabilities',
    specs: ['tests/e2e/ssh-orcad-browser-capabilities.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/main\/(?:runtime\/(?:runtime-browser-commands-factory|orca-runtime-get-status)|host\/electron-browser-commands|orcad\/orcad-browser-)/.test(
        file
      )
  },
  {
    id: 'browser.orcad-service-status',
    specs: ['tests/e2e/ssh-orcad-browser-service-status.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/components\/browser-pane\/stream-remote\/remote-browser-stream-(?:errors|status|lifecycle|restart-attempt)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-browser-routing',
    specs: ['tests/e2e/ssh-orcad-browser-routing.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/browser\/local-ssh-browser|main\/ipc\/browser\.ts$|renderer\/src\/(?:lib\/(?:ssh-workspace-browser-route-eligibility|worktree-host-connection-phase)|components\/browser-pane\/use-ssh-workspace-browser-route|store\/repos\/converted-ssh-browser-pages|store\/slices\/browser\/browser-tab-actions|hooks\/ipc-events\/ssh-managed-server-state-effects))/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-terminal-browser-link',
    specs: ['tests/e2e/ssh-orcad-terminal-browser-link.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/(?:lib\/(?:workspace-browser-tab-open|http-link-(?:destinations|routing)|ssh-workspace-browser-route-eligibility)|components\/terminal-pane\/terminal-http-link-source-owner)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-desktop-browser-bridge',
    specs: ['tests/e2e/ssh-orcad-desktop-browser-bridge.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:shared\/desktop-browser-bridge-protocol\.ts$|main\/(?:runtime\/desktop-browser-bridge\/|browser\/desktop-browser-bridge\/|ipc\/desktop-browser-bridge-|runtime\/rpc\/methods\/desktop-browser-bridge\.ts$))/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-browser-drop-owner',
    specs: ['tests/e2e/ssh-orcad-browser-drop-owner.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      /^tests\/e2e\/helpers\/browser-split-(?:guest-probes|page-server)\.ts$/.test(file) ||
      (isProductSource(file) &&
        /^src\/renderer\/src\/(?:lib\/(?:file-preview|workspace-file-drag|worktree-runtime-owner|connection-context)\.ts|components\/(?:right-sidebar\/FileExplorer(?:Row|VirtualRows)\.tsx|browser-pane\/(?:navigate\/use-browser-page-navigation-downloads\.ts|host-guest\/attach-browser-page-webview\.ts)))$/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-open-in-owner',
    specs: ['tests/e2e/ssh-orcad-open-in-owner.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/renderer\/src\/(?:lib\/(?:local-path-open-guard|external-editor-open-capability|worktree-runtime-owner)\.ts|components\/(?:sidebar\/(?:WorktreeOpenInMenu|WorktreeContextMenuView)\.tsx|right-sidebar\/(?:FileExplorer(?:Toolbar)?\.tsx|source-control\/listing\/entry-context-menu\.tsx)))$/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-terminal-root-owner',
    specs: ['tests/e2e/ssh-orcad-terminal-root-owner.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      file === 'tests/e2e/helpers/terminal-workspace-root-link.ts' ||
      (isProductSource(file) &&
        /^src\/renderer\/src\/(?:components\/terminal-pane\/terminal-(?:worktree-path-link|file-link-actions|file-link-hit-testing|file-open-routing|link-handlers)\.ts|lib\/(?:workspace-file-host-routing|worktree-owner-route|worktree-operation-route|worktree-operation-catalog-route)\.ts)$/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-idle-exit',
    specs: ['tests/e2e/ssh-orcad-idle-exit.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:orcad\/orcad-(?:idle-|managed-idle-)|(?:ssh|managed-server\/[a-z-]+)\/orcad-(?:already-active-wake|runtime-deployment|managed-serving|managed-wake|managed-tunnel|recovery-slot|remote-launch|remote-runtime-control))|shared\/orcad-idle-exit)/.test(
          file
        ))
  },
  {
    // Why: managed SSH hosts are now the only SSH path, so these specs carry its user journeys.
    // Connect/Disconnect sources too: the journeys disconnect and reconnect a managed host (#30130).
    id: 'ssh.orcad-journeys',
    specs: [
      'tests/e2e/ssh-orcad-terminal-journeys.spec.ts',
      'tests/e2e/ssh-orcad-workspace-tools.spec.ts',
      'tests/e2e/ssh-orcad-vm-provisioned-root.spec.ts'
    ],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      /^tests\/e2e\/helpers\/(?:paired-host-terminal|terminal-workspace-root-link)\.ts$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:ssh|managed-server\/[a-z-]+)\/orcad-managed-|main\/ipc\/(?:ssh\/)?ssh-port-forward|main\/(?:ipc\/(?:(?:ssh\/)?ssh-(?:connect-flow|connection-handlers|host-user-disconnect|session-teardown)|(?:runtime-environments\/)?runtime-environment-(?:connectivity-handlers|manual-disconnect))|ssh\/(?:connection\/ssh-connection-manager|ssh-user-disconnect))\.ts$|renderer\/src\/startup\/(?:ssh-startup-reconnect|startup-ssh-connection-restore)\.ts$|renderer\/src\/runtime\/(?:web-runtime-session|web-session-close-|runtime-terminal-artifact-read\.ts$)|renderer\/src\/components\/terminal-pane\/(?:remote-runtime-|terminal-host-(?:workspace-file|file-link-existence)\.ts$))/.test(
          file
        ))
  },
  {
    // Why: hand-kept routes missed #30130 and #30120; scoped to managed-host code to bound lane cost.
    id: 'ssh.orcad-remote-sources',
    specs: [
      'tests/e2e/ssh-orcad-paired-phone-projects.spec.ts',
      'tests/e2e/ssh-orcad-retained-upgrade-state.spec.ts',
      'tests/e2e/ssh-orcad-shared-home-machines.spec.ts',
      'tests/e2e/ssh-orcad-shared-login-migration.spec.ts',
      'tests/e2e/ssh-orcad-terminal-network-outage.spec.ts',
      'tests/e2e/ssh-orcad-windows-cli-matrix.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/(?:ssh|orcad|managed-server)\/|main\/ipc\/(?:ssh|runtime-environment|orcad-)|cli\/runtime\/(?:launch-)?serve|shared\/(?:remote-runtime|orcad-|protocol-version\.ts$|runtime-capability)|renderer\/src\/store\/repos\/(?:repo-removal|runtime-project-terminal-stop)|renderer\/src\/components\/sidebar\/(?:sleep-|SleepTwin|WorkspaceSleep|use-worktree-sleep|ssh-host-remove|host-rename-remove|HostRemove))/.test(
        file
      )
  },
  {
    // The spec runs only in a switch-on build; it guards the phone's list against the desktop's.
    id: 'ssh.orcad-phone-feed-list',
    specs: ['tests/e2e/ssh-orcad-phone-feed-list.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      /^tests\/e2e\/helpers\/(?:phone-feed-list|sidebar-inputs-build)\.ts$/.test(file) ||
      (isProductSource(file) &&
        /^(?:src\/shared\/sidebar-list\/sidebar-(?:feed|inputs)-|mobile\/src\/host-screen\/host-sidebar-feed-)/.test(
          file
        ))
  },
  {
    id: 'browser-network.ssh-docker-route',
    specs: ['tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'],
    matches: (file) =>
      file === 'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts' ||
      /^tests\/e2e\/helpers\/docker-ssh-host-(?:image|target)\.ts$/.test(file) ||
      (isProductSource(file) &&
        /^src\/main\/(?:browser\/(?:ssh-browser-network-execution-route|browser-network-deferred-socket|browser-network-execution-route|system-ssh-socks-client-socket)|ssh\/system-transport\/system-ssh-dynamic-forward-process)\.ts$/.test(
          file
        ))
  },
  {
    id: 'terminal.windows-wsl-launch-and-paste',
    specs: [
      'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
      'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:config\/scripts\/(?:verify-wsl-e2e-participation|verify-playwright-participation)\.mjs$|src\/main\/(?:wsl[/-]|pty\/.*wsl|providers\/wsl)|src\/shared\/(?:wsl-|windows-terminal-shell|shell-argument-quoting)|src\/renderer\/src\/.*(?:terminal-paste|pty-paste)|tests\/e2e\/(?:golden-tab-bar-agent-launch\.spec|terminal-windows-shell-paste-ownership\.spec|terminal-inline-images-windows\.spec|helpers\/(?:wsl-golden-stub-agent|golden-stub-agent))|\.github\/(?:actions\/setup-wsl-test-runtime\/|workflows\/windows-wsl-e2e\.yml))/.test(
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
      (XTERM_CORE_PATCH.test(file) ||
        /^src\/renderer\/src\/components\/terminal-pane\/(?:terminal-ime-|use-terminal-pane-lifecycle|xterm-bypass-policy|terminal-option-shortcut-policy)/.test(
          file
        ))
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
      (isProductSource(file) &&
        (XTERM_CORE_PATCH.test(file) || NATIVE_IME_PRODUCT_SOURCE.test(file))) ||
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
      /^(?:src\/main\/ipc\/filesystem-(?:list-files|search-file-paths)\.ts|src\/main\/ripgrep\/bundled-ripgrep-path\.ts|src\/main\/providers\/(?:filesystem-provider-contract|ssh-filesystem-provider(?:-capabilities)?)\.ts|src\/main\/runtime\/(?:orca-runtime-files|rpc\/methods\/files)\.ts|src\/renderer\/src\/(?:components\/(?:QuickOpen|quick-open-file-list|quick-open-search)\.tsx?|runtime\/(?:runtime-file-search-client|runtime-legacy-quick-open-inventory)\.ts)|src\/shared\/(?:quick-open-(?:install-rg|path-search|transport-budget)|ripgrep-process-availability|bundled-ripgrep)\.ts)$/.test(
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
    // Why a route of its own: every other terminal-pane route names what BINDS a pane — the pty
    // transports, the ssh reconnect ledgers, the park watchers. Nothing named what unbinds one,
    // so the close/retire lifecycle reached main with e2e skipped outright. Unbinding is the half
    // that can strand a PTY or leave a retired leaf mounted as a blank pane.
    //
    // Deliberately absent: src/renderer/src/runtime/runtime-rpc-client.ts, the transport these
    // retirements call out through. It carries no close decision and churns ~3x these files, so
    // routing on it would run this lane on unrelated runtime work.
    id: 'terminal-pane.close-and-retirement',
    specs: [
      // Closing a tab whose pane is parked (never mounted) must retire that exact PTY.
      'tests/e2e/terminal-parked-close-retirement.spec.ts',
      // Closing one leaf of a split must leave root leaves, leaf→pty bindings, and live panes
      // agreeing — the ghost-blank-pane shape a bad unbind produces.
      'tests/e2e/terminal-pane-close-layout-consistency.spec.ts',
      // The runtime half: a leaf the host retires must stop being mounted on a paired client.
      'tests/e2e/paired-remote-split-pane-host-retired-ghost.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:retire-unbound-(?:ipc|runtime)-terminal-pane|terminal-pane-(?:close-admission|close-identity|lifecycle-close|pane-closed|retirement-ownership)|use-terminal-pane-close-actions)|src\/renderer\/src\/store\/(?:terminals\/terminal-tab-close(?:-providers)?|slices\/(?:terminal-tab-retirement|terminal-retirement-teardown-reservation|retired-terminal-tab-state-sweep)))\.ts$/.test(
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
      /^(?:src\/main\/daemon\/(?:daemon-attach-only-retirement|daemon-pty-applied-size|daemon-pty-session-control|daemon-pty-spawn-result)\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:remote-runtime-pty-transport|terminal-error-accumulation)\.ts|src\/renderer\/src\/runtime\/(?:web-runtime-terminal-creation|web-runtime-session-tab-lifecycle|web-session-tabs-sync\/use-web-session-tabs-sync|web-session-terminal-orphan-(?:topology|recovery(?:-(?:adoption|surface|inventory|inventory-validation|cache|queue|rpc-lane|pane))?))\.ts)$/.test(
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
    // Why: layout resolution is the only place a split direction can be invented, and the
    // loss is one-way — the guess is published and written back over the real tree.
    id: 'terminal-session.split-orientation-resolution',
    specs: ['tests/e2e/desktop-published-split-orientation-legacy-leaf.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/runtime\/(?:remote-terminal-layout-resolution\.ts|sync-runtime-graph\/(?:graph-publication|mobile-session-terminal-tabs|mobile-session-surfaces)\.ts|web-session-tabs-sync\/terminal-surfaces\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-session.remote-pane-layout-retry',
    specs: ['tests/e2e/paired-remote-pane-layout-retry.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:remote-pane-layout-push|TerminalPane)\.tsx?|src\/renderer\/src\/lib\/terminal-layout-equality\.ts|src\/renderer\/src\/runtime\/web-session-tabs-sync\/use-web-session-tabs-sync\.ts|src\/renderer\/src\/store\/slices\/terminals\.ts)$/.test(
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
      (file === 'src/main/runtime/browser/browser-commands.ts' ||
        /^src\/.*(?:[Cc]lient-?[Hh]osted|browser-host-(?:lease|page|client-page)|browser-client-(?:host|page)|runtime-browser-(?:client-)?page|session-tabs-sync|host-session-snapshot-authority|orca-runtime\.ts|\/runtime-(?:status|types)\.ts)/.test(
          file
        ))
  }
]

export function selectPrE2eSpecs(
  changedPaths,
  reportRoute = () => undefined,
  { allowDaemonInitTestSupport = false } = {}
) {
  const routePaths = isDaemonInitTestSupportChange(changedPaths, allowDaemonInitTestSupport)
    ? changedPaths.filter((file) => file !== DAEMON_INIT_TEST_SUPPORT)
    : changedPaths
  // The required layout_oracle job owns the oracle specs; running them here too would double the cost.
  const specs = new Set(
    changedPaths.filter(
      (file) => /^tests\/e2e\/.*\.spec\.ts$/.test(file) && !LAYOUT_ORACLE_E2E_SPECS.includes(file)
    )
  )
  for (const route of PR_E2E_SOURCE_ROUTES) {
    const matchedFiles = routePaths.filter(route.matches)
    if (matchedFiles.length === 0) {
      continue
    }
    route.specs.forEach((spec) => specs.add(spec))
    reportRoute(`[pr-e2e] ${route.id}: ${route.specs.join(', ')}`)
  }
  return [...specs].sort((left, right) => left.localeCompare(right))
}

/** Routes whose authorities a real input method can judge, and so require the native IME lane. */
export const NATIVE_IME_SOURCE_ROUTE_IDS = ['terminal-ime.native-input-method']

// Why derived from the routes: the native lane must trigger on IME source, not on the native
// spec surviving in some route's spec list.
export function hasNativeImeSourceChange(changedPaths) {
  return PR_E2E_SOURCE_ROUTES.filter((route) =>
    NATIVE_IME_SOURCE_ROUTE_IDS.includes(route.id)
  ).some((route) => changedPaths.some(route.matches))
}

export function shouldRunReusablePrE2e(changedPaths, options = {}) {
  // Native IME has its own workflow.
  return selectPrE2eSpecs(changedPaths, undefined, options).some(
    (spec) => spec !== 'tests/e2e/terminal-ibus-hangul-native.spec.ts'
  )
}

export function hasWslSourceChange(changedPaths) {
  const route = PR_E2E_SOURCE_ROUTES.find(
    (candidate) => candidate.id === 'terminal.windows-wsl-launch-and-paste'
  )
  return changedPaths.some(route.matches)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  const changedPaths = input.split(/\r?\n/).filter(Boolean)
  const options = {
    allowDaemonInitTestSupport: process.argv.includes('--daemon-init-test-support')
  }
  if (process.argv.includes('--reusable-workflow')) {
    process.stdout.write(`${shouldRunReusablePrE2e(changedPaths, options)}\n`)
  } else if (process.argv.includes('--wsl-source')) {
    process.stdout.write(`${hasWslSourceChange(changedPaths)}\n`)
  } else if (process.argv.includes('--native-ime-source')) {
    process.stdout.write(`${hasNativeImeSourceChange(changedPaths)}\n`)
  } else {
    const specs = selectPrE2eSpecs(changedPaths, (message) => console.error(message), options)
    process.stdout.write(`${JSON.stringify(specs)}\n`)
  }
}
