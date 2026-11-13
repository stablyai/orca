import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  DAEMON_INIT_TEST_SUPPORT,
  isDaemonInitTestSupportChange,
  isUnitTestSupportSource
} from './pr-code-change-scope.mjs'
import { MANAGED_SSH_E2E_SPEC_PREFIX } from '../../ci/e2e-selection/ci-e2e-job-selection.mjs'
import { LAYOUT_ORACLE_E2E_SPECS } from './pr-layout-oracle-route.mjs'
import { PR_BROWSER_E2E_SOURCE_ROUTES } from './pr-browser-e2e-source-routes.mjs'
import { PR_EDITOR_PREVIEW_E2E_SOURCE_ROUTES } from './pr-editor-preview-e2e-source-routes.mjs'
import { PR_FEATURE_AREA_E2E_SOURCE_ROUTES } from './pr-feature-area-e2e-source-routes.mjs'
import { PR_PLUGIN_E2E_SOURCE_ROUTES } from './pr-plugin-e2e-source-routes.mjs'
import { PR_WSL_E2E_SOURCE_ROUTES } from './pr-wsl-e2e-source-routes.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

// The core xterm patch owns the helper textarea an input method attaches to.
const XTERM_CORE_PATCH =
  /^config\/patches\/(?:@xterm__xterm@[^/]+\.patch|xterm-src\/@xterm__xterm@[^/]+\.src\.patch)$/

// Paths follow the input/ime and input/keyboard owners (#39113); the pre-move paths matched nothing.
const NATIVE_IME_PRODUCT_SOURCE =
  /^(?:src\/shared\/terminal-unicode-provider\.ts$|src\/renderer\/src\/lib\/pane-manager\/terminal-input\/terminal-ime-|src\/renderer\/src\/components\/terminal-pane\/input\/(?:ime\/|keyboard\/xterm-bypass-policy|terminal-pane-pane-input\.ts$))/

/** The harness itself: the session runner, the boundary probes, and the native specs. */
const NATIVE_IME_HARNESS =
  /^(?:config\/scripts\/(?:runtime-verification\/terminal-e2e\/)?(?:diagnostics\/wayland\/)?focus-nested-wayland-terminal\.sh$|config\/scripts\/(?:runtime-verification\/terminal-e2e\/)?(?:diagnostics\/wayland\/)?(?:run-terminal-ibus-hangul-e2e|terminal-ime-engagement-receipt)\.mjs$|tests\/e2e\/terminal-ime-(?:boundary-probe|byte-reader|engagement-receipt)\.ts$|tests\/e2e\/terminal-(?:ibus-hangul|hangul-terminating-digit|macos-2set-korean)-native\.spec\.ts$)/

// This spec requires ORCA_SIDEBAR_INPUTS=main; ordinary PR builds can only skip it.
export const MANUAL_ONLY_E2E_SPECS = ['tests/e2e/ssh-orcad-phone-feed-list.spec.ts']

// Shared fixtures and workflow changes must exercise every managed-SSH consumer.
const MANAGED_SSH_HARNESS =
  /^tests\/e2e\/helpers\/(?:orcad-managed-workspace|orcad-convert-(?:flow|host|teardown)|orcad-template-variant|orcad-upgrade-(?:profile|retained-state)|docker-ssh-host-target|reserve-local-port|ssh-remote-only-browser-fixture|windows-host-orcad-processes)\.ts$/

// An enabled SSH automation moves with its host and is re-enabled on the server (#29083).
const ENABLED_AUTOMATION_MOVE =
  /^src\/(?:main\/(?:persistence\/(?:migrating-orcad-catalog\/(?:source\/(?:automations\/orcad-source-automation-state|dormancy\/orcad-source-dormant-state|sessions\/orcad-source-dependency-census)|destination\/orcad-destination-automation-state)|scheduling-automations\/automation-schedule-operations)|automations\/(?:run-target-resolution|automation-dispatch-request|orcad-fenced-automation)|persistence\/migrating-orcad-catalog\/retained-source\/orcad-migration-(?:moved-automations|source-retention))|shared\/orcad-migration\/orcad-migration-(?:dormant-automation-validation|source-cutover))\.ts$/

export const PR_E2E_SOURCE_ROUTES = [
  ...PR_BROWSER_E2E_SOURCE_ROUTES,
  ...PR_EDITOR_PREVIEW_E2E_SOURCE_ROUTES,
  ...PR_FEATURE_AREA_E2E_SOURCE_ROUTES,
  ...PR_PLUGIN_E2E_SOURCE_ROUTES,
  ...PR_WSL_E2E_SOURCE_ROUTES,
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
      /^src\/renderer\/src\/components\/editor\/(?:markdown\/documents\/useMarkdownDocuments|restored-editor-workspace-runtime-owner|migrate-restored-editor-file-owner)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-markdown-link-refresh',
    specs: ['tests/e2e/ssh-orcad-markdown-link-refresh.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/components\/editor\/rich-markdown\/(?:doc-links\/rich-markdown-doc-link|instance\/useRichMarkdownProgrammaticSync)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-markdown-live-documents',
    specs: ['tests/e2e/ssh-orcad-markdown-live-documents.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/components\/editor\/markdown\/documents\/(?:useMarkdownDocuments|use-markdown-document-watch-refresh|markdown-document-list-request)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-explorer-watch-recovery',
    specs: ['tests/e2e/ssh-orcad-explorer-watch-recovery.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      (file ===
        'src/renderer/src/components/right-sidebar/file-explorer/watching/useFileExplorerWatch.ts' ||
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
      (file ===
        'src/renderer/src/components/right-sidebar/file-explorer/watching/useFileExplorerWatch.ts' ||
        file ===
          'src/renderer/src/components/right-sidebar/file-explorer/navigation/file-explorer-operation-owner.ts' ||
        file === 'src/renderer/src/components/right-sidebar/file-explorer/panel/FileExplorer.tsx' ||
        file === 'src/renderer/src/hooks/editor-external-watch-targets.ts' ||
        file ===
          'src/renderer/src/components/right-sidebar/file-explorer/tree/useFileExplorerTree.ts' ||
        file ===
          'src/renderer/src/components/right-sidebar/file-explorer/tree/use-file-explorer-tree-load-effects.ts')
  },
  {
    // A paired client refuses project setup on its server's SSH host with a clear reason (#33124).
    id: 'paired.ssh-host-project-setup',
    specs: ['tests/e2e/headless-paired-ssh-host-project-setup.spec.ts'],
    matches: (file) =>
      file === 'tests/e2e/helpers/headless-paired-runtime-host.ts' ||
      (isProductSource(file) &&
        /^src\/(?:renderer\/src\/store\/projects\/project-host-setup-actions|main\/runtime\/runtime-project-host-setup-controller|shared\/project-host-setup-target)\.ts$/.test(
          file
        ))
  },
  {
    id: 'serve.orcad-mode-switch',
    specs: ['tests/e2e/orcad-serve-mode-switch.spec.ts'],
    matches: (file) =>
      /^tests\/e2e\/helpers\/(?:orca-serve-cli-host|headless-paired-runtime-host)\.ts$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /^src\/(?:cli\/runtime\/(?:launch|serve-)|main\/orcad\/(?:main|orcad-entry|orcad-command-startup|orcad-instance-lock|orcad-command-arguments|orcad-lifecycle)\.ts$|main\/startup\/profile-startup\/desktop-profile-instance-lock\.ts$|main\/daemon\/(?:[^/]+\/)*daemon-(?:spawner|endpoint-adoption|init)|main\/server\/serve-)/.test(
          file
        ))
  },
  {
    id: 'startup.windows-missing-appdata',
    specs: ['tests/e2e/windows-missing-appdata-startup.spec.ts'],
    matches: (file) =>
      file === 'tests/e2e/helpers/orca-serve-cli-host.ts' ||
      (isProductSource(file) &&
        /^src\/main\/startup\/(?:windows-startup\/windows-app-data-path|main-process-preflight)\.ts$/.test(
          file
        ))
  },
  {
    id: 'clipboard.windows-copy-file',
    specs: ['tests/e2e/file-explorer-copy-file-windows.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/window\/clipboard\/clipboard-(?:file-copy|ipc-handlers)|renderer\/src\/components\/right-sidebar\/file-explorer\/panel\/file-explorer-row-file-transfer)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-connect-failure',
    specs: [
      'tests/e2e/ssh-orcad-ssh-failure-reason.spec.ts',
      'tests/e2e/ssh-orcad-move-anyway-inline.spec.ts',
      'tests/e2e/ssh-orcad-enabled-automation-move.spec.ts'
    ],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      ENABLED_AUTOMATION_MOVE.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:ipc\/ssh\/(?:ssh-connect-flow|ssh-host-server-)|ssh\/(?:ssh-session-start-failure|ssh-host-server-|connection\/ssh-connection-manager|orcad-migration-refusal-reason|targets\/ssh-target-orcad-preflight)|managed-server\/lifecycle\/orcad-runtime-conversion|persistence\/migrating-orcad-catalog\/source\/(?:automations\/orcad-source-automation-state|catalog\/orcad-source-leave-behind-view))|renderer\/src\/(?:ssh\/(?:ssh-host-server-status-copy|ssh-connect-failure-toast)|components\/settings\/(?:SshTargetServerStatus|SshHostMoveAnywayAction|SshTargetCard)))/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-identity-file-tokens',
    specs: ['tests/e2e/ssh-orcad-identity-file-tokens.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      /^tests\/e2e\/helpers\/ssh-config-host-picker\.ts$/.test(file) ||
      (isProductSource(file) &&
        /^src\/main\/ssh\/(?:config\/(?:ssh-g-config-resolution|ssh-identity-file-tokens|ssh-config-path-expansion)|ssh-auth-resolution|ssh-identity-file-read)\.ts$/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-update-anyway',
    specs: ['tests/e2e/ssh-orcad-update-anyway.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:ssh\/orcad-(?:update-plan|runtime-maintenance|installed-activation|remote-deploy)|managed-server\/lifecycle\/orcad-(?:managed-update-|managed-auto-update|runtime-status|managed-version-gc)|managed-server\/install\/(?:orcad-remote-gc|remote-install-gc)|wsl\/orcad\/wsl-orcad-deploy\.ts)|renderer\/src\/components\/settings\/(?:managed-server-|use-managed-server-lifecycle))/.test(
          file
        ))
  },
  // COMPAT(legacy-relay-bridge): revisit 2027-01-15 with src/main/ssh/legacy-relay/.
  {
    id: 'ssh.orcad-legacy-relay-bridge',
    specs: [
      'tests/e2e/ssh-orcad-legacy-relay-bridge.spec.ts',
      'tests/e2e/ssh-orcad-relay-tab-only-shell.spec.ts'
    ],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      /^tests\/e2e\/(?:helpers\/(?:legacy-relay-docker-host|build-released-relay-bundle)|cross-version-wire\/released-relay-(?:daemon|transport))\.m?ts$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /(?:legacy-relay(?:-bridge|\/)|orcad-migration-terminal-gate|ssh-host-relay-terminals-on-connect|orcad-source-dependency-census)/.test(
          file
        ))
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
      /^src\/(?:main\/browser\/routing\/local-host-partitions\/local-ssh-browser|main\/ipc\/browser\.ts$|renderer\/src\/(?:lib\/(?:ssh-workspace-browser-route-eligibility|worktree-host-connection-phase)|components\/browser-pane\/use-ssh-workspace-browser-route|store\/repos\/converted-ssh-browser-pages|store\/slices\/browser\/tabs\/browser-tab-actions|hooks\/ipc-events\/ssh-managed-server-state-effects))/.test(
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
        /^src\/renderer\/src\/(?:lib\/(?:browser\/documents\/file-preview|workspace-file-drag|worktree-runtime-owner)\.ts|lib\/workspace\/ownership\/connection-context\.ts|components\/(?:right-sidebar\/file-explorer\/panel\/FileExplorer(?:Row|VirtualRows)\.tsx|browser-pane\/(?:navigate\/use-browser-page-navigation-downloads\.ts|host-guest\/attach-browser-page-webview\.ts)))$/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-open-in-owner',
    specs: ['tests/e2e/ssh-orcad-open-in-owner.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/renderer\/src\/(?:lib\/(?:local-path-open-guard|external-editor-open-capability|worktree-runtime-owner)\.ts|components\/(?:sidebar\/workspace-actions\/(?:open\/WorktreeOpenInMenu|context-menu\/WorktreeContextMenuView)\.tsx|right-sidebar\/(?:file-explorer\/panel\/FileExplorer(?:Toolbar)?\.tsx|source-control\/listing\/entry-context-menu\.tsx)))$/.test(
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
        /^src\/renderer\/src\/(?:components\/terminal-pane\/terminal-(?:worktree-path-link|file-link-actions|file-link-hit-testing|file-open-routing|link-handlers)\.ts|(?:runtime\/files\/workspace-file-host-routing|lib\/workspace\/ownership\/(?:worktree-owner-route|worktree-operation-route|worktree-operation-catalog-route))\.ts)$/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-sleep-disconnected',
    specs: ['tests/e2e/ssh-orcad-sleep-disconnected.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/runtime\/(?:workspaces\/(?:workspace-sleep-|remote-workspace-terminal-sleep)|terminal\/stop\/worktree-terminal-sleep)|renderer\/src\/components\/sidebar\/workspace-actions\/sleep\/(?:sleep-|workspace-sleep-))/.test(
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
    // Managed SSH is the only SSH path; include Connect/Disconnect so journeys exercise reconnect (#30130).
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
        /^src\/(?:main\/(?:ssh|managed-server\/[a-z-]+)\/orcad-managed-|main\/ipc\/(?:ssh\/)?ssh-port-forward|main\/(?:ipc\/(?:(?:ssh\/)?ssh-(?:connect-flow|connection-handlers|host-user-disconnect|session-teardown)|(?:runtime-environments\/(?:connectivity\/)?)?runtime-environment-(?:connectivity-handlers|manual-disconnect))|ssh\/(?:connection\/ssh-connection-manager|ssh-user-disconnect))\.ts$|renderer\/src\/startup\/(?:ssh-startup-reconnect|startup-ssh-connection-restore)\.ts$|renderer\/src\/runtime\/(?:web-runtime-session|web-session-close-|runtime-terminal-artifact-read\.ts$)|renderer\/src\/components\/terminal-pane\/(?:pty-transport\/remote-runtime\/remote-runtime-|terminal-host-(?:workspace-file|file-link-existence)\.ts$))/.test(
          file
        ))
  },
  {
    // A Claude chat a managed host's CLI refuses to start names why (#33768).
    id: 'ssh.orcad-claude-chat-start-failure',
    specs: ['tests/e2e/ssh-orcad-claude-chat-start-failure.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      file === 'tests/e2e/fixtures/structured-claude-stub.cjs' ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:claude\/(?:claude-(?:stream-json-connection|structured-session-exit-lifecycle)|sdk-transport\/claude-stream-json-exit-error)|native-chat\/agent-session-wire\/structured-agent-session-failure-text)|renderer\/src\/components\/native-chat\/structured-agent-session-delivery-notices)\.ts$/.test(
          file
        ))
  },
  {
    // A reconnect the host cannot image must still bring an idle full-screen program up to date (#26887).
    id: 'ssh.orcad-reconnect-idle-frame',
    specs: ['tests/e2e/ssh-orcad-terminal-reconnect-idle-frame.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:renderer\/src\/components\/terminal-pane\/(?:pty-transport\/remote-runtime\/remote-runtime-|pty-connection\/(?:geometry\/remote-program-redraw|output-restore\/(?:hidden-output-restore-|park-reveal-snapshot-verdict)))|main\/runtime\/rpc\/methods\/terminal\/terminal-(?:multiplex-initial-snapshot|snapshot-publication)\.ts$)/.test(
          file
        ))
  },
  {
    // Unsaved drafts stay on the desktop and are renamed to the server when a move commits.
    id: 'ssh.orcad-editor-drafts-migration',
    specs: ['tests/e2e/ssh-orcad-editor-drafts-migration.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/main\/(?:persistence\/migrating-orcad-catalog\/source\/(?:worktrees\/orcad-source-draft-rename|sessions\/orcad-source-(?:workspace-session|session-copy-resolution)|catalog\/orcad-source-export)|persistence\/migrating-orcad-catalog\/retained-source\/orcad-migration-source-retention|ipc\/ssh\/ssh)\.ts$/.test(
          file
        ))
  },
  {
    // A saved managed tunnel port that can no longer be bound moves to a free one (#33182).
    id: 'ssh.orcad-unbindable-tunnel-port',
    specs: ['tests/e2e/ssh-orcad-unbindable-tunnel-port.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/managed-server\/lifecycle\/orcad-managed-tunnel|main\/ssh\/system-transport\/system-ssh-forward-port-reservation|shared\/runtime-environment-(?:sidecar|managed-orcad-store))/.test(
          file
        ))
  },
  {
    // Why: hand-kept routes missed #30130 and #30120; scoped to managed-host code to bound lane cost.
    id: 'ssh.orcad-remote-sources',
    specs: [
      'tests/e2e/ssh-orcad-paired-phone-projects.spec.ts',
      'tests/e2e/ssh-orcad-pairing-repair.spec.ts',
      'tests/e2e/ssh-orcad-shared-home-machines.spec.ts',
      'tests/e2e/ssh-orcad-shared-login-migration.spec.ts',
      'tests/e2e/ssh-orcad-terminal-network-outage.spec.ts',
      'tests/e2e/ssh-orcad-windows-cli-matrix.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/(?:ssh|orcad|managed-server)\/|main\/ipc\/(?:ssh|runtime-environment|orcad-)|cli\/runtime\/(?:launch-)?serve|shared\/(?:remote-runtime|orcad-|protocol-version\.ts$|runtime-capability)|renderer\/src\/store\/repos\/(?:repo-removal|runtime-project-terminal-stop)|renderer\/src\/components\/sidebar\/(?:workspace-actions\/sleep\/(?:sleep-|SleepTwin|WorkspaceSleep|use-worktree-sleep)|ssh-host-remove|host-rename-remove|HostRemove)|renderer\/src\/components\/terminal-pane\/(?:pty-transport\/remote-runtime\/recovery\/(?:TerminalRemoteRuntimeReconnectBanner|use-managed-pairing-refused)|controller\/TerminalPaneCodexRestartPortals|process-exit\/TerminalPaneProcessExitPortals|pty-transport\/recovery\/ssh\/TerminalPaneSshReconnectPortals|mobile-driver\/TerminalPaneMobileDriverPortals))/.test(
        file
      )
  },
  {
    id: 'browser-network.ssh-docker-route',
    specs: ['tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'],
    matches: (file) =>
      file === 'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts' ||
      /^tests\/e2e\/helpers\/docker-ssh-host-(?:image|target)\.ts$/.test(file) ||
      (isProductSource(file) &&
        /^src\/main\/(?:browser\/network\/(?:execution-routes\/(?:ssh-browser-network-execution-route|browser-network-deferred-socket|browser-network-execution-route)|tunnels\/system-ssh-socks-client-socket)|ssh\/system-transport\/system-ssh-dynamic-forward-process)\.ts$/.test(
          file
        ))
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
        /^src\/renderer\/src\/components\/terminal-pane\/(?:input\/ime\/terminal-ime-|controller\/use-terminal-pane-lifecycle|input\/keyboard\/(?:xterm-bypass-policy|terminal-option-shortcut-policy))/.test(
          file
        ))
  },
  {
    // CDP Input.imeSetComposition proves synthetic handling without an IME; this separate route alone selects the real ibus-hangul lane.
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
      /^(?:src\/renderer\/src\/components\/tab-bar\/TabBarQuickCommandsMenu\.tsx|src\/renderer\/src\/hooks\/use-terminal-quick-command-hosts\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:pty-transport\/ipc\/pty-transport|pty-transport\/ipc\/terminal-pty-pre-spawn-e2e-barrier)\.ts|src\/renderer\/src\/components\/terminal-pane\/pty-connection\/(?:connect-pane-pty|spawn\/fresh-spawn-start|lifecycle\/active-pane-pty-binding|notifications\/terminal-bell-completion-arbitration|input\/terminal-input-activity|host-ownership\/pane-transport-bootstrap|emulation\/(?:pane-capability-replies|pane-mode-2031-state)|geometry\/pane-viewport-claim|lifecycle\/pty-input-recovery)\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:TerminalPane|use-terminal-pane-lifecycle)\.tsx?|src\/renderer\/src\/store\/slices\/terminals\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-session.host-cold-park-stream-continuity',
    specs: ['tests/e2e/host-parked-pane-remote-viewer.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:terminal-hidden-view-parking|terminal-tab-park-candidates|parking\/retention\/terminal-tab-activation-order|terminal-parked-pty-watcher|terminal-parked-tab-watchers|terminal-parked-watcher-registry)\.ts|src\/renderer\/src\/runtime\/sync-runtime-graph\.ts)$/.test(
        file
      )
  },
  {
    // Route unbind/retirement as well as binders: missed lifecycle edges can strand PTYs or leave blank mounted leaves.
    // Omit runtime-rpc-client.ts: it makes no close decision and churns ~3x as often, triggering unrelated work.
    id: 'terminal-pane.close-and-retirement',
    specs: [
      // Closing a tab whose pane is parked (never mounted) must retire that exact PTY.
      'tests/e2e/terminal-parked-close-retirement.spec.ts',
      // Split-leaf close must preserve agreement among root leaves, leaf-to-PTY bindings and live panes to prevent ghost blanks.
      'tests/e2e/terminal-pane-close-layout-consistency.spec.ts',
      // The runtime half: a leaf the host retires must stop being mounted on a paired client.
      'tests/e2e/paired-remote-split-pane-host-retired-ghost.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:layout\/close\/retire-unbound-(?:ipc|runtime)-terminal-pane|terminal-pane-(?:close-admission|close-identity|lifecycle-close|pane-closed|retirement-ownership)|use-terminal-pane-close-actions)|src\/renderer\/src\/store\/(?:terminals\/retirement\/terminal-tab-close(?:-providers)?|slices\/(?:terminal-tab-retirement|terminal-retirement-teardown-reservation|retired-terminal-tab-state-sweep)))\.ts$/.test(
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
      /^(?:src\/main\/daemon\/(?:[^/]+\/)*(?:daemon-attach-only-retirement|daemon-pty-applied-size|daemon-pty-session-control|daemon-pty-spawn-result)\.ts|src\/renderer\/src\/components\/terminal-pane\/(?:pty-transport\/remote-runtime\/remote-runtime-pty-transport|errors\/terminal-error-accumulation)\.ts|src\/renderer\/src\/runtime\/(?:web-runtime-terminal-creation|web-runtime-session-tab-lifecycle|web-session-tabs-sync\/use-web-session-tabs-sync|web-session-terminal-orphan-(?:topology|recovery(?:-(?:adoption|surface|inventory|inventory-validation|cache|queue|rpc-lane|pane))?))\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-provider.ssh-remote-reattach-contract',
    specs: ['tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      !file.endsWith('-test-harness.ts') &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/pty-transport\/remote-runtime\/remote-runtime-pty-transport(?:-[a-z0-9-]+)?\.ts|src\/renderer\/src\/runtime\/remote-runtime-terminal-multiplexer\.ts)$/.test(
        file
      )
  },
  {
    id: 'terminal-session.remote-pane-layout-retry',
    specs: ['tests/e2e/paired-remote-pane-layout-retry.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:layout\/persistence\/remote-pane-layout-push|TerminalPane)\.tsx?|src\/renderer\/src\/lib\/terminal-layout-equality\.ts|src\/renderer\/src\/runtime\/web-session-tabs-sync\/use-web-session-tabs-sync\.ts|src\/renderer\/src\/store\/slices\/terminals\.ts)$/.test(
        file
      )
  },
  {
    // Connector code only: the shared launcher, writer and hook store it reuses already have their own routes.
    id: 'connectors.headless-serve-conversation',
    specs: ['tests/e2e/connector-headless-serve.spec.ts'],
    matches: (file) =>
      file === 'tests/e2e/helpers/connector-fake-claude.ts' ||
      (isProductSource(file) &&
        /^src\/(?:main\/external-conversations\/|main\/runtime\/rpc\/methods\/connector\.ts$|cli\/(?:connectors|specs)\/connector\.ts$|shared\/rpc-contract\/connectors\/connector-params\.ts$)/.test(
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
      (file) =>
        /^tests\/e2e\/.*\.spec\.ts$/.test(file) &&
        !LAYOUT_ORACLE_E2E_SPECS.includes(file) &&
        !MANUAL_ONLY_E2E_SPECS.includes(file)
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
  if (
    routePaths.some(
      (file) =>
        (file.startsWith('tests/e2e/helpers/') &&
          [...specs].some((spec) => spec.startsWith(MANAGED_SSH_E2E_SPEC_PREFIX))) ||
        file === '.github/workflows/e2e.yml' ||
        file === '.github/scripts/prepare-ubuntu-apt.sh' ||
        file === 'config/scripts/ci/e2e-selection/ci-e2e-job-selection.mjs'
    )
  ) {
    specs.add(MANAGED_SSH_E2E_SPEC_PREFIX)
  }
  return [...specs].sort((left, right) => left.localeCompare(right))
}

/** Routes whose authorities a real input method can judge, and so require the native IME lane. */
export const NATIVE_IME_SOURCE_ROUTE_IDS = ['terminal-ime.native-input-method']

// Derive native-IME triggers from source routes, independent of whether a route still lists the native spec.
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
