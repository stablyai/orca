import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  DAEMON_INIT_TEST_SUPPORT,
  isDaemonInitTestSupportChange,
  isUnitTestSupportSource
} from './pr-code-change-scope.mjs'
import { MANAGED_SSH_E2E_SPECS } from '../../ci/e2e-selection/ci-e2e-job-selection.mjs'
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
  /(?:^(?:config\/scripts\/(?:runtime-verification\/terminal-e2e\/)?(?:diagnostics\/wayland\/)?focus-nested-wayland-terminal\.sh$|config\/scripts\/(?:runtime-verification\/terminal-e2e\/)?(?:diagnostics\/wayland\/)?(?:run-terminal-ibus-hangul-e2e|terminal-ime-engagement-receipt)\.mjs$)|^(?:tests\/e2e\/terminal\/ime\/terminal-ibus-hangul-native\.spec\.ts|tests\/e2e\/terminal\/ime\/terminal-ime-boundary-probe\.ts|tests\/e2e\/terminal\/ime\/terminal-ime-byte-reader\.ts|tests\/e2e\/terminal\/ime\/terminal-ime-engagement-receipt\.ts)$)/

// This spec requires ORCA_SIDEBAR_INPUTS=main; ordinary PR builds can only skip it.
export const MANUAL_ONLY_E2E_SPECS = []

// Shared fixtures and workflow changes must exercise every managed-SSH consumer.
const MANAGED_SSH_HARNESS =
  /^(?:tests\/e2e\/browser\/remote-hosted\/ssh-remote-only-browser-fixture\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/docker-ssh-host-target\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-convert-flow\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-convert-host\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-managed-workspace\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-template-variant\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-upgrade-profile\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-upgrade-retained-state\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/reserve-local-port\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/windows-host-orcad-processes\.ts)$/

export const PR_E2E_SOURCE_ROUTES = [
  ...PR_EDITOR_PREVIEW_E2E_SOURCE_ROUTES,
  ...PR_FEATURE_AREA_E2E_SOURCE_ROUTES,
  ...PR_PLUGIN_E2E_SOURCE_ROUTES,
  ...PR_WSL_E2E_SOURCE_ROUTES,
  {
    id: 'ssh.orcad-explorer-watch-recovery',
    specs: [
      'tests/e2e/remote/managed-ssh/file-lifecycle/ssh-orcad-explorer-watch-recovery.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      (file ===
        'src/renderer/src/components/right-sidebar/file-explorer/watching/useFileExplorerWatch.ts' ||
        file === 'src/renderer/src/runtime/files/watching/worktree-file-change-event.ts')
  },
  {
    id: 'ssh.orcad-editor-watch-recovery',
    specs: ['tests/e2e/remote/managed-ssh/file-lifecycle/ssh-orcad-editor-watch-recovery.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/hooks\/useEditorExternalWatch\.ts|src\/renderer\/src\/components\/editor\/external-changes\/watching\/editor-runtime-file-watch\.ts)$/.test(
        file
      )
  },

  {
    id: 'serve.orcad-mode-switch',
    specs: ['tests/e2e/remote/managed-ssh/host-lifecycle/orcad-serve-mode-switch.spec.ts'],
    matches: (file) =>
      /^(?:tests\/e2e\/remote\/paired-runtime\/client-hosts\/headless-paired-runtime-host\.ts|tests\/e2e\/remote\/paired-runtime\/client-hosts\/orca-serve-cli-host\.ts)$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /^src\/(?:cli\/runtime\/(?:launch|profile\/launch-user-data-path|commands\/serve-|app-launch\/serve-|serve\/(?:startup|supervision|updates)\/serve-)|main\/orcad\/(?:[^/]+\/)?(?:main|orcad-entry|orcad-command-startup|orcad-instance-lock|orcad-command-arguments|orcad-lifecycle)\.ts$|main\/backend\/core-runtime(?:-activation)?\.ts$|main\/startup\/profile-startup\/desktop-profile-instance-lock\.ts$|main\/daemon\/(?:[^/]+\/)*daemon-(?:spawner|endpoint-adoption|init)|main\/server\/serve-)/.test(
          file
        ))
  },
  {
    // A Slack event reaches a bot on a signed-in orcad; sign-out and quit fence its connector.
    id: 'serve.orcad-connector-server-bot',
    specs: ['tests/e2e/integrations/connectors/orcad-connector-server-bot.spec.ts'],
    matches: (file) =>
      /^tests\/e2e\/integrations\/connectors\/(?:orca-cloud-auth-fixture|connector-actions-cloud-fixture)\.ts$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:orcad\/orcad-(?:connector|orca-account|entry|runtime-lifetime|relay)|connector-cloud\/connector-(?:host-install|cloud|cloud-install|token-mint)|ipc\/pty\/host-env\/inherited-orca-identity-(?:env|claim))|cli\/handlers\/bot-reply)\.ts$/.test(
          file
        ))
  },
  {
    id: 'startup.windows-missing-appdata',
    specs: ['tests/e2e/desktop/startup-recovery/windows-missing-appdata-startup.spec.ts'],
    matches: (file) =>
      file === 'tests/e2e/remote/paired-runtime/client-hosts/orca-serve-cli-host.ts' ||
      (isProductSource(file) &&
        /^src\/main\/startup\/(?:windows-startup\/windows-app-data-path|main-process-preflight)\.ts$/.test(
          file
        ))
  },
  {
    id: 'clipboard.windows-copy-file',
    specs: ['tests/e2e/editor/file-explorer/file-explorer-copy-file-windows.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/window\/clipboard\/clipboard-(?:file-copy|ipc-handlers)|renderer\/src\/components\/right-sidebar\/file-explorer\/panel\/file-explorer-row-file-transfer)\.ts$/.test(
        file
      )
  },
  {
    id: 'ssh.orcad-update-anyway',
    specs: ['tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-update-anyway.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:ssh\/orcad-(?:update-plan|runtime-maintenance|installed-activation|remote-deploy)|managed-server\/lifecycle\/orcad-(?:managed-update-|managed-auto-update|runtime-status|managed-version-gc)|managed-server\/install\/(?:orcad-remote-gc|remote-install-gc)|wsl\/orcad\/wsl-orcad-deploy\.ts)|renderer\/src\/components\/settings\/(?:managed-server-|use-managed-server-lifecycle))/.test(
          file
        ))
  },
  {
    id: 'ssh.orcad-idle-exit',
    specs: ['tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-idle-exit.spec.ts'],
    matches: (file) =>
      MANAGED_SSH_HARNESS.test(file) ||
      (isProductSource(file) &&
        /^src\/(?:main\/(?:orcad\/orcad-(?:idle-|managed-idle-)|(?:ssh|managed-server\/[a-z-]+)\/orcad-(?:already-active-wake|runtime-deployment|managed-serving|managed-wake|managed-tunnel|recovery-slot|remote-launch|remote-runtime-control))|shared\/orcad-idle-exit)/.test(
          file
        ))
  },
  {
    // A saved managed tunnel port that can no longer be bound moves to a free one (#33182).
    id: 'ssh.orcad-unbindable-tunnel-port',
    specs: ['tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-unbindable-tunnel-port.spec.ts'],
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
      'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-pairing-repair.spec.ts',
      'tests/e2e/remote/managed-ssh/host-lifecycle/ssh-orcad-shared-home-machines.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/(?:ssh|orcad|managed-server)\/|main\/ipc\/(?:ssh|runtime-environment|orcad-)|cli\/runtime\/(?:launch-serve|(?:commands|app-launch)\/serve|serve\/(?:startup|supervision|updates)\/serve)|shared\/(?:remote-runtime|orcad-|protocol-version\.ts$|runtime-capability)|renderer\/src\/store\/repos\/(?:repo-removal|runtime-project-terminal-stop)|renderer\/src\/components\/sidebar\/(?:workspace-actions\/sleep\/(?:sleep-|SleepTwin|WorkspaceSleep|use-worktree-sleep)|ssh-host-remove|host-rename-remove|HostRemove)|renderer\/src\/components\/terminal-pane\/(?:pty-transport\/remote-runtime\/recovery\/(?:TerminalRemoteRuntimeReconnectBanner|use-managed-pairing-refused)|controller\/TerminalPaneCodexRestartPortals|process-exit\/TerminalPaneProcessExitPortals|pty-transport\/recovery\/ssh\/TerminalPaneSshReconnectPortals|mobile-driver\/TerminalPaneMobileDriverPortals))/.test(
        file
      )
  },
  {
    id: 'browser-network.ssh-docker-route',
    specs: ['tests/e2e/remote/ssh-hosts/ssh-browser-network-execution-route.docker.unit.test.ts'],
    matches: (file) =>
      file ===
        'tests/e2e/remote/ssh-hosts/ssh-browser-network-execution-route.docker.unit.test.ts' ||
      /^(?:tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/docker-ssh-host-image\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/docker-ssh-host-target\.ts)$/.test(
        file
      ) ||
      (isProductSource(file) &&
        /^src\/main\/(?:browser\/network\/(?:execution-routes\/(?:ssh-browser-network-execution-route|browser-network-deferred-socket|browser-network-execution-route)|tunnels\/system-ssh-socks-client-socket)|ssh\/system-transport\/system-ssh-dynamic-forward-process)\.ts$/.test(
          file
        ))
  },
  {
    id: 'terminal-input.ime-and-synthetic-forwarding',
    specs: ['tests/e2e/terminal/ime/terminal-korean-preedit-visibility.spec.ts'],
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
    specs: ['tests/e2e/terminal/ime/terminal-ibus-hangul-native.spec.ts'],
    matches: (file) =>
      (isProductSource(file) &&
        (XTERM_CORE_PATCH.test(file) || NATIVE_IME_PRODUCT_SOURCE.test(file))) ||
      NATIVE_IME_HARNESS.test(file)
  },
  {
    // Route unbind/retirement as well as binders: missed lifecycle edges can strand PTYs or leave blank mounted leaves.
    // Omit runtime-rpc-client.ts: it makes no close decision and churns ~3x as often, triggering unrelated work.
    id: 'terminal-pane.close-and-retirement',
    specs: [
      // Closing a tab whose pane is parked (never mounted) must retire that exact PTY.
      'tests/e2e/terminal/retention/terminal-parked-close-retirement.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:src\/renderer\/src\/components\/terminal-pane\/(?:layout\/close\/retire-unbound-(?:ipc|runtime)-terminal-pane|terminal-pane-(?:close-admission|close-identity|lifecycle-close|pane-closed|retirement-ownership)|use-terminal-pane-close-actions)|src\/renderer\/src\/store\/(?:terminals\/retirement\/(?:terminal-tab-close(?:-providers)?|terminal-tab-retirement|terminal-retirement-teardown-reservation|retired-terminal-tab-state-sweep)))\.ts$/.test(
        file
      )
  },
  {
    // A bot link opens the chat its conversation is linked to.
    id: 'connectors.bot-link-opens-chat',
    specs: ['tests/e2e/integrations/bots/bot-deep-link.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/(?:main\/bots\/bot-deep-link-open\.ts|main\/external-conversations\/external-conversation-links\.ts|shared\/bot-deep-link\.ts|renderer\/src\/hooks\/ipc-events\/bot-deep-link-ipc-bridge\.ts)$/.test(
        file
      )
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
  const specs = new Set(
    changedPaths.filter(
      (file) =>
        /^(?:tests\/e2e\/activity\/ai-vault-session-delete\.spec\.ts|tests\/e2e\/agents\/native-chat\/native-chat-automation-saved-card\.spec\.ts|tests\/e2e\/agents\/native-chat\/native-chat-send-focus\.spec\.ts|tests\/e2e\/agents\/native-chat\/native-chat-worker-follow-up\.spec\.ts|tests\/e2e\/agents\/remote-sessions\/paired-serve-cold-restore-agent-status\.spec\.ts|tests\/e2e\/agents\/remote-sessions\/paired-server-agent-tab-placement\.spec\.ts|tests\/e2e\/agents\/session-lifecycle\/agent-descendant-process-kill\.spec\.ts|tests\/e2e\/agents\/session-lifecycle\/grok-hook-session-cleanup\.spec\.ts|tests\/e2e\/agents\/session-lifecycle\/issue-12907-pi-eof-agent-row\.spec\.ts|tests\/e2e\/agents\/session-lifecycle\/omp-launch-environment\.spec\.ts|tests\/e2e\/agents\/session-lifecycle\/omp-model-picker\.spec\.ts|tests\/e2e\/agents\/settings\/codex-account-switch-dismiss\.spec\.ts|tests\/e2e\/agents\/settings\/settings-agent-awake\.spec\.ts|tests\/e2e\/browser\/client-hosted\/paired-client-hosted-browser-markup\.spec\.ts|tests\/e2e\/browser\/client-hosted\/paired-client-hosted-profile-cookies\.spec\.ts|tests\/e2e\/browser\/guest-lifecycle\/browser-embedded-owner-routing\.spec\.ts|tests\/e2e\/browser\/guest-lifecycle\/browser-guest-crash-recovery\.spec\.ts|tests\/e2e\/browser\/input-navigation\/browser-agent-input-focus-isolation\.spec\.ts|tests\/e2e\/browser\/input-navigation\/browser-grab-top-layer\.spec\.ts|tests\/e2e\/browser\/input-navigation\/browser-split-grab-shortcut\.spec\.ts|tests\/e2e\/browser\/input-navigation\/browser-tab\.spec\.ts|tests\/e2e\/browser\/remote-hosted\/headless-serve-browser-tab-restart\.spec\.ts|tests\/e2e\/browser\/remote-hosted\/paired-remote-browser-blank-link\.spec\.ts|tests\/e2e\/browser\/remote-hosted\/paired-remote-browser-ghost-subscriber-rejoin\.spec\.ts|tests\/e2e\/browser\/remote-hosted\/paired-remote-browser-in-page-address\.spec\.ts|tests\/e2e\/browser\/security\/browser-fedcm-fallback\.spec\.ts|tests\/e2e\/desktop\/clipboard\/app-menu-paste-ownership\.spec\.ts|tests\/e2e\/desktop\/clipboard\/clipboard-macos-image-paste\.spec\.ts|tests\/e2e\/desktop\/clipboard\/editable-context-paste-ownership\.spec\.ts|tests\/e2e\/desktop\/clipboard\/tab-rename-paste-ownership\.spec\.ts|tests\/e2e\/desktop\/daemon-lifecycle\/daemon-lifecycle-retirement\.spec\.ts|tests\/e2e\/desktop\/startup-recovery\/electron-home-isolation\.spec\.ts|tests\/e2e\/desktop\/startup-recovery\/renderer-crash-recovery-terminal-input\.spec\.ts|tests\/e2e\/desktop\/startup-recovery\/restart-restore-terminal-input\.spec\.ts|tests\/e2e\/desktop\/startup-recovery\/restart-unopened-workspace-terminal-attach\.spec\.ts|tests\/e2e\/desktop\/startup-recovery\/windows-missing-appdata-startup\.spec\.ts|tests\/e2e\/editor\/csv\/csv-paged-preview\.spec\.ts|tests\/e2e\/editor\/csv\/csv-url-links\.spec\.ts|tests\/e2e\/editor\/file-explorer\/file-explorer-copy-file-windows\.spec\.ts|tests\/e2e\/editor\/file-explorer\/runtime-file-browser-windows-drives\.spec\.ts|tests\/e2e\/editor\/file-lifecycle\/editor-model-host-isolation\.spec\.ts|tests\/e2e\/editor\/markdown\/markdown-callout-source-fidelity\.spec\.ts|tests\/e2e\/editor\/markdown\/markdown-find-adversarial\.spec\.ts|tests\/e2e\/editor\/markdown\/markdown-nested-toggle\.spec\.ts|tests\/e2e\/editor\/markdown\/rich-markdown-inline-image\.spec\.ts|tests\/e2e\/editor\/pdf\/pdf-detail-device-pixels\.spec\.ts|tests\/e2e\/editor\/pdf\/pdf-find-counter\.spec\.ts|tests\/e2e\/editor\/previews\/media-preview-partition-isolation\.spec\.ts|tests\/e2e\/golden-journeys\/golden-agent-tui-launch\.spec\.ts|tests\/e2e\/golden-journeys\/golden-file-open-edit-save\.spec\.ts|tests\/e2e\/golden-journeys\/golden-fresh-profile-terminal\.spec\.ts|tests\/e2e\/golden-journeys\/golden-posix-profile-index-fsync\.spec\.ts|tests\/e2e\/golden-journeys\/golden-shell-after-agent-exit\.spec\.ts|tests\/e2e\/golden-journeys\/golden-shell-command\.spec\.ts|tests\/e2e\/golden-journeys\/golden-source-control-commit\.spec\.ts|tests\/e2e\/golden-journeys\/golden-source-control-open-diff\.spec\.ts|tests\/e2e\/golden-journeys\/golden-tab-bar-agent-launch\.spec\.ts|tests\/e2e\/golden-journeys\/golden-worktree-create-switch\.spec\.ts|tests\/e2e\/integrations\/bots\/bot-automation-result-note\.spec\.ts|tests\/e2e\/integrations\/bots\/bot-deep-link\.spec\.ts|tests\/e2e\/integrations\/bots\/bot-item-view-width\.spec\.ts|tests\/e2e\/integrations\/bots\/bot-reveal-current\.spec\.ts|tests\/e2e\/integrations\/bots\/paired-server-bots-survive-disconnect\.spec\.ts|tests\/e2e\/integrations\/connectors\/connector-actions-bot-run\.spec\.ts|tests\/e2e\/integrations\/connectors\/connector-first-setup\.spec\.ts|tests\/e2e\/integrations\/connectors\/orcad-connector-server-bot\.spec\.ts|tests\/e2e\/integrations\/linear\/linear-url-workspace-entry\.spec\.ts|tests\/e2e\/integrations\/skills\/staging-skill-sharing\.spec\.ts|tests\/e2e\/layout\/window-tabs\/floating-tab-rename-filesystem-alias\.spec\.ts|tests\/e2e\/layout\/window-tabs\/floating-tab-rename\.spec\.ts|tests\/e2e\/layout\/window-tabs\/floating-terminal-tab-rename-focus\.spec\.ts|tests\/e2e\/layout\/window-tabs\/floating-workspace-reopen-webgl-recovery\.spec\.ts|tests\/e2e\/layout\/window-tabs\/floating-workspace-shared-glyph-atlas\.spec\.ts|tests\/e2e\/layout\/window-tabs\/narrow-tab-group-drag-handle\.spec\.ts|tests\/e2e\/layout\/window-tabs\/tabs\.spec\.ts|tests\/e2e\/plugins\/plugin-declarative-panel\.spec\.ts|tests\/e2e\/plugins\/plugin-isolated-frame\.spec\.ts|tests\/e2e\/plugins\/plugin-name-clash\.spec\.ts|tests\/e2e\/plugins\/plugin-new-file\.spec\.ts|tests\/e2e\/plugins\/plugin-panel-agents\.spec\.ts|tests\/e2e\/plugins\/plugin-workspace-persist-switch\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/file-lifecycle\/ssh-orcad-editor-watch-recovery\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/file-lifecycle\/ssh-orcad-explorer-watch-recovery\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/orcad-serve-mode-switch\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/ssh-orcad-idle-exit\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/ssh-orcad-pairing-repair\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/ssh-orcad-shared-home-machines\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/ssh-orcad-unbindable-tunnel-port\.spec\.ts|tests\/e2e\/remote\/managed-ssh\/host-lifecycle\/ssh-orcad-update-anyway\.spec\.ts|tests\/e2e\/remote\/mobile-mirror\/headless-mobile-markdown\.spec\.ts|tests\/e2e\/remote\/mobile-mirror\/headless-serve-mobile-markdown\.spec\.ts|tests\/e2e\/remote\/mobile-mirror\/headless-serve-mobile-native-chat-identity\.spec\.ts|tests\/e2e\/remote\/mobile-mirror\/mobile-subscribe-idle-hidden-pane-fit\.spec\.ts|tests\/e2e\/remote\/mobile-mirror\/paired-mobile-desktop-mirror-files-git-review\.spec\.ts|tests\/e2e\/remote\/mobile-mirror\/paired-mobile-serve-restart-terminal-tabs\.spec\.ts|tests\/e2e\/remote\/paired-runtime\/workspace-routing\/headless-serve-desktop-activation\.spec\.ts|tests\/e2e\/remote\/paired-runtime\/workspace-routing\/paired-client-project-removal-stops-host-terminals\.spec\.ts|tests\/e2e\/remote\/paired-runtime\/workspace-routing\/paired-server-rows-shadow\.spec\.ts|tests\/e2e\/remote\/paired-runtime\/workspace-routing\/paired-startup-exec-readiness\.spec\.ts|tests\/e2e\/remote\/paired-runtime\/workspace-routing\/paired-worktree-activation-isolation\.spec\.ts|tests\/e2e\/remote\/paired-runtime\/workspace-routing\/pr11346-selected-runtime-add\.spec\.ts|tests\/e2e\/remote\/ssh-hosts\/ephemeral-vm-cleanup-retry\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-bridge-no-background-boot\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-host-fake-transport\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-move-host-pane-history\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-move-moved-project-chat-send\.spec\.ts|tests\/e2e\/source-control\/source-control-commit-message-ai\.spec\.ts|tests\/e2e\/source-control\/source-control-create-pr\.spec\.ts|tests\/e2e\/source-control\/source-control-discard-confirmation\.spec\.ts|tests\/e2e\/source-control\/source-control-pr-generation-switch\.spec\.ts|tests\/e2e\/source-control\/source-control-pr-linked-issue-ai\.spec\.ts|tests\/e2e\/source-control\/source-control-staged-rename\.spec\.ts|tests\/e2e\/terminal\/ime\/terminal-ibus-hangul-native\.spec\.ts|tests\/e2e\/terminal\/ime\/terminal-korean-preedit-visibility\.spec\.ts|tests\/e2e\/terminal\/ime\/terminal-linux-claimed-preedit-selector\.spec\.ts|tests\/e2e\/terminal\/ime\/terminal-option-composed-ascii\.spec\.ts|tests\/e2e\/terminal\/input\/terminal-paste-ownership\.spec\.ts|tests\/e2e\/terminal\/input\/terminal-shortcuts\.spec\.ts|tests\/e2e\/terminal\/input\/terminal-windows-codex-multiline-paste\.spec\.ts|tests\/e2e\/terminal\/input\/terminal-windows-path-expansion\.spec\.ts|tests\/e2e\/terminal\/input\/terminal-windows-shell-paste-ownership\.spec\.ts|tests\/e2e\/terminal\/layout\/terminal-close-pane-focus\.spec\.ts|tests\/e2e\/terminal\/layout\/terminal-closed-pane-quit-relaunch\.spec\.ts|tests\/e2e\/terminal\/layout\/terminal-pane-content-retention\.spec\.ts|tests\/e2e\/terminal\/layout\/terminal-pane-split-identity\.spec\.ts|tests\/e2e\/terminal\/layout\/terminal-split-pane-paste-ownership\.spec\.ts|tests\/e2e\/terminal\/lifecycle\/automation-hidden-terminal-first-mount\.spec\.ts|tests\/e2e\/terminal\/lifecycle\/terminal-codex-home\.spec\.ts|tests\/e2e\/terminal\/lifecycle\/terminal-osc-color-queries\.spec\.ts|tests\/e2e\/terminal\/lifecycle\/terminal-scroll-intent-follow\.spec\.ts|tests\/e2e\/terminal\/lifecycle\/terminal-tab-level-binding-upgrade\.spec\.ts|tests\/e2e\/terminal\/lifecycle\/terminal-wedged-write-pipeline-recovery\.spec\.ts|tests\/e2e\/terminal\/links\/terminal-link-click-ownership\.spec\.ts|tests\/e2e\/terminal\/remote-input\/headless-paired-remote-terminal-early-typing\.spec\.ts|tests\/e2e\/terminal\/remote-input\/headless-paired-remote-terminal-stall-recovery\.spec\.ts|tests\/e2e\/terminal\/remote-layout\/headless-paired-remote-terminal-reveal-grid\.spec\.ts|tests\/e2e\/terminal\/remote-layout\/headless-paired-remote-terminal-viewer-size\.spec\.ts|tests\/e2e\/terminal\/remote-layout\/paired-remote-terminal-pane-move-to-new-tab\.spec\.ts|tests\/e2e\/terminal\/remote-parking\/paired-remote-terminal-initial-snapshot-scrollback\.spec\.ts|tests\/e2e\/terminal\/remote-parking\/paired-remote-terminal-truncated-tail-first-paint\.spec\.ts|tests\/e2e\/terminal\/rendering\/terminal-column-desync-repro\.spec\.ts|tests\/e2e\/terminal\/rendering\/terminal-dom-block-decorations\.spec\.ts|tests\/e2e\/terminal\/rendering\/terminal-tab-switch-visual-restore\.spec\.ts|tests\/e2e\/terminal\/retention\/terminal-parked-close-retirement\.spec\.ts|tests\/e2e\/terminal\/retention\/terminal-restart-persistence\.spec\.ts|tests\/e2e\/terminal\/retention\/terminal-sleep-wake-restore\.spec\.ts|tests\/e2e\/terminal\/retention\/terminal-tab-close-running-confirm-mouse\.spec\.ts|tests\/e2e\/terminal\/retention\/terminal-tab-close-running-confirm\.spec\.ts|tests\/e2e\/workspaces\/lifecycle\/default-branch-visibility\.spec\.ts|tests\/e2e\/workspaces\/lifecycle\/local-worktree-visibility-runtime-active\.spec\.ts|tests\/e2e\/workspaces\/lifecycle\/worktree-jump-palette-folder-workspaces\.spec\.ts|tests\/e2e\/workspaces\/project-admission\/new-workspace-cross-project-dialog\.spec\.ts|tests\/e2e\/workspaces\/project-admission\/new-workspace-linked-item-project-switch\.spec\.ts|tests\/e2e\/workspaces\/project-admission\/project-group-manual-sort\.spec\.ts|tests\/e2e\/workspaces\/project-admission\/repo-registration-async\.spec\.ts|tests\/e2e\/workspaces\/sidebar\/sidebar-folder-keyboard-navigation\.spec\.ts|tests\/e2e\/workspaces\/sidebar\/sidebar-unread-older-paired-host\.spec\.ts|tests\/e2e\/workspaces\/sidebar\/sidebar-workspace-rows\.spec\.ts|tests\/e2e\/workspaces\/sidebar\/workspace-board-lane-virtualization\.spec\.ts|tests\/e2e\/workspaces\/sidebar\/worktree-parent-reorder\.spec\.ts|tests\/e2e\/workspaces\/sleep\/workspace-sleep-in-main\.spec\.ts)$/.test(
          file
        ) && !MANUAL_ONLY_E2E_SPECS.includes(file)
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
        ([
          'tests/e2e/agents/session-fixtures/agent-hook-endpoint.ts',
          'tests/e2e/agents/session-fixtures/claude-plugin-image-fixture.ts',
          'tests/e2e/agents/session-fixtures/fake-agent-command-override.ts',
          'tests/e2e/agents/session-fixtures/fake-agent-paste-end-scanner.ts',
          'tests/e2e/agents/session-fixtures/fake-codex-launch-probes.ts',
          'tests/e2e/agents/session-fixtures/native-chat-transcript-fixture.ts',
          'tests/e2e/agents/session-fixtures/native-chat-view.ts',
          'tests/e2e/agents/session-fixtures/structured-claude-stub.ts',
          'tests/e2e/agents/settings/cursor-quota-wire.fixture.ts',
          'tests/e2e/browser/client-hosted/client-hosted-browser-fixture.ts',
          'tests/e2e/browser/client-hosted/client-hosted-browser-observer.ts',
          'tests/e2e/browser/guest-lifecycle/browser-sidecar-launch.ts',
          'tests/e2e/browser/input-navigation/browser-agent-composition-scenario.ts',
          'tests/e2e/browser/input-navigation/browser-agent-focus-scenarios.ts',
          'tests/e2e/browser/input-navigation/browser-link-server.ts',
          'tests/e2e/browser/input-navigation/browser-split-fixture.ts',
          'tests/e2e/browser/input-navigation/browser-split-guest-probes.ts',
          'tests/e2e/browser/input-navigation/browser-split-page-server.ts',
          'tests/e2e/browser/placement/paired-browser-placement-fixture.ts',
          'tests/e2e/browser/remote-hosted/materialized-remote-browser-pane.ts',
          'tests/e2e/browser/remote-hosted/ssh-remote-only-browser-fixture.ts',
          'tests/e2e/browser/security/local-https-test-server.ts',
          'tests/e2e/desktop/cli-invocation/compiled-orca-cli.ts',
          'tests/e2e/desktop/computer-use/computer-cli-driver.ts',
          'tests/e2e/desktop/computer-use/computer-coordinate-click-driver.ts',
          'tests/e2e/desktop/computer-use/computer-driver.ts',
          'tests/e2e/desktop/computer-use/notepad-document.ts',
          'tests/e2e/desktop/computer-use/windows-fixture-actions.ts',
          'tests/e2e/desktop/computer-use/windows-form-fixture.ts',
          'tests/e2e/desktop/computer-use/windows-ime-native-events.ts',
          'tests/e2e/desktop/computer-use/windows-semantic-controls-fixture.ps1',
          'tests/e2e/desktop/computer-use/windows-semantic-controls-fixture.ts',
          'tests/e2e/desktop/computer-use/windows-semantic-controls-fixture.winforms.ps1',
          'tests/e2e/desktop/daemon-lifecycle/daemon-generation-processes.ts',
          'tests/e2e/desktop/daemon-lifecycle/daemon-generation-runtime-fixture.ts',
          'tests/e2e/desktop/daemon-lifecycle/daemon-generation-safety-fixtures.ts',
          'tests/e2e/desktop/electron-fixtures/e2e-completed-onboarding-profile.ts',
          'tests/e2e/desktop/electron-fixtures/electron-crashpad-cleanup.ts',
          'tests/e2e/desktop/electron-fixtures/electron-home-isolation.ts',
          'tests/e2e/desktop/electron-fixtures/electron-home-isolation.unit.test.ts',
          'tests/e2e/desktop/electron-fixtures/electron-launch-args.ts',
          'tests/e2e/desktop/electron-fixtures/electron-main-evaluate-retry.ts',
          'tests/e2e/desktop/electron-fixtures/electron-process-shutdown.ts',
          'tests/e2e/desktop/electron-fixtures/electron-shutdown-timing.ts',
          'tests/e2e/desktop/electron-fixtures/hidden-renderer-frame-capture.ts',
          'tests/e2e/desktop/electron-fixtures/hold-window-graph-publication.ts',
          'tests/e2e/desktop/electron-fixtures/orca-app.ts',
          'tests/e2e/desktop/electron-fixtures/orca-restart-launch-options.ts',
          'tests/e2e/desktop/electron-fixtures/orca-restart.ts',
          'tests/e2e/desktop/electron-fixtures/persisted-profile-state.ts',
          'tests/e2e/desktop/electron-fixtures/persisted-profile-state.unit.test.ts',
          'tests/e2e/desktop/electron-fixtures/renderer-console-forwarding.ts',
          'tests/e2e/desktop/renderer-probes/event-loop-delay-report.ts',
          'tests/e2e/desktop/renderer-probes/first-drawn-watch.ts',
          'tests/e2e/desktop/renderer-probes/onboarding-navigation.ts',
          'tests/e2e/desktop/renderer-probes/page-evaluate-polled.ts',
          'tests/e2e/desktop/renderer-probes/runtime-types.ts',
          'tests/e2e/desktop/renderer-probes/shortcuts.ts',
          'tests/e2e/desktop/renderer-probes/store.ts',
          'tests/e2e/desktop/settings/settings-pane-visits.ts',
          'tests/e2e/editor/file-explorer/file-explorer.ts',
          'tests/e2e/editor/markdown/markdown-editor-fixture.ts',
          'tests/e2e/editor/markdown/markdown-inline-image.ts',
          'tests/e2e/editor/markdown/markdown-nested-toggle.ts',
          'tests/e2e/editor/pdf/pdf-find-fixture.ts',
          'tests/e2e/editor/previews/paired-html-preview-inventory.ts',
          'tests/e2e/golden-journeys/golden-source-control.ts',
          'tests/e2e/golden-journeys/golden-stub-agent.ts',
          'tests/e2e/layout/publication/host-split-and-sleep-journeys.ts',
          'tests/e2e/layout/publication/layout-owner-build.ts',
          'tests/e2e/layout/publication/main-terminal-layout.ts',
          'tests/e2e/layout/publication/paired-desktop-server-layout.ts',
          'tests/e2e/layout/publication/terminal-layout-journeys.ts',
          'tests/e2e/layout/version-compatibility/layout-compat-baseline.ts',
          'tests/e2e/layout/workspace-oracle/headless-layout-oracle-hosts.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-compare.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-expected.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-feed.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-markers.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-model.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-session.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-stream.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-views.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle-watch.ts',
          'tests/e2e/layout/workspace-oracle/workspace-layout-oracle.ts',
          'tests/e2e/orchestration/completed-worker-retirement-fixture.ts',
          'tests/e2e/orchestration/orchestration-mail-pane-agent.ts',
          'tests/e2e/orchestration/orchestration-mail-store.ts',
          'tests/e2e/plugins/plugin-frame-guest.ts',
          'tests/e2e/plugins/plugin-git-fixture.ts',
          'tests/e2e/plugins/plugin-gleam-catalog-fixture.ts',
          'tests/e2e/plugins/plugin-panel-navigation-observer.ts',
          'tests/e2e/plugins/plugin-smoke.ts',
          'tests/e2e/plugins/plugin-update-catalog-fixture.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/docker-ssh-host-image.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/docker-ssh-host-target.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-convert-flow.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-convert-host.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-managed-workspace.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-template-variant.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-upgrade-profile.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/orcad-upgrade-retained-state.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/reserve-local-port.ts',
          'tests/e2e/remote/managed-ssh/host-lifecycle/windows-host-orcad-processes.ts',
          'tests/e2e/remote/mobile-mirror/paired-mobile-client.ts',
          'tests/e2e/remote/mobile-mirror/phone-feed-list.ts',
          'tests/e2e/remote/mobile-mirror/phone-mirror-topology.ts',
          'tests/e2e/remote/network-outages/freezable-tcp-proxy.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/client-hosted-runtime-relaunch.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/headless-paired-runtime-host.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/headless-paired-runtime-serve-readiness.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/headless-paired-runtime-serve-readiness.unit.test.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/nested-runtime-same-id-pairing.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/orca-serve-cli-host.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/packaged-old-orca.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/paired-client-host-session.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/paired-client-runtime-environment.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/paired-client-window-reveal.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/paired-electron-client.ts',
          'tests/e2e/remote/paired-runtime/client-hosts/paired-web-client-url.ts',
          'tests/e2e/remote/paired-runtime/ssh-routing/nested-runtime-ssh-client-route.ts',
          'tests/e2e/remote/paired-runtime/ssh-routing/nested-runtime-ssh-filesystem-route.ts',
          'tests/e2e/remote/paired-runtime/ssh-routing/nested-runtime-ssh-terminal-creation.ts',
          'tests/e2e/remote/relay/build-released-relay-bundle.mts',
          'tests/e2e/remote/relay/legacy-relay-docker-host.ts',
          'tests/e2e/remote/relay/relay-execution-process.ts',
          'tests/e2e/remote/ssh-hosts/remote-skill-cloud-fixture.ts',
          'tests/e2e/remote/ssh-hosts/ssh-config-host-picker.ts',
          'tests/e2e/remote/ssh-hosts/staging-skill-ssh-target.ts',
          'tests/e2e/remote/wsl-hosts/wsl-boot-diagnostics-log.ts',
          'tests/e2e/remote/wsl-hosts/wsl-boot-guard.ts',
          'tests/e2e/remote/wsl-hosts/wsl-golden-stub-agent.ts',
          'tests/e2e/remote/wsl-hosts/wsl-host-fake-desktop.ts',
          'tests/e2e/remote/wsl-hosts/wsl-moved-host-profile.ts',
          'tests/e2e/remote/wsl-hosts/wsl-terminate-retry.ts',
          'tests/e2e/source-control/pr-comments-sidebar-fixture.ts',
          'tests/e2e/source-control/source-control-ai-generation.ts',
          'tests/e2e/source-control/source-control-ai-generators.ts',
          'tests/e2e/source-control/source-control-generation-app.ts',
          'tests/e2e/terminal/input/dead-terminal.ts',
          'tests/e2e/terminal/input/run-node-script-in-terminal.ts',
          'tests/e2e/terminal/input/terminal-accessibility-tree.ts',
          'tests/e2e/terminal/input/terminal-active-pane.ts',
          'tests/e2e/terminal/input/terminal-input-probes.ts',
          'tests/e2e/terminal/input/terminal-kitty-file-image-proof.ts',
          'tests/e2e/terminal/input/terminal-kitty-keyboard.ts',
          'tests/e2e/terminal/input/terminal-pty-injection.ts',
          'tests/e2e/terminal/input/terminal-pty-write-spy.ts',
          'tests/e2e/terminal/input/terminal.ts',
          'tests/e2e/terminal/layout/terminal-inventory-observation.ts',
          'tests/e2e/terminal/layout/terminal-pane-geometry.ts',
          'tests/e2e/terminal/layout/terminal-pane-identity.ts',
          'tests/e2e/terminal/layout/terminal-pane-mount-readiness.ts',
          'tests/e2e/terminal/layout/terminal-pane-operations.ts',
          'tests/e2e/terminal/layout/terminal-pane-title-actions.ts',
          'tests/e2e/terminal/layout/terminal-tab-menu.ts',
          'tests/e2e/terminal/layout/terminal-title-log.ts',
          'tests/e2e/terminal/links/terminal-workspace-root-link.ts',
          'tests/e2e/terminal/output/alt-screen-frame.ts',
          'tests/e2e/terminal/performance/layout-latency-probe.ts',
          'tests/e2e/terminal/performance/tab-render-recorder.ts',
          'tests/e2e/terminal/performance/terminal-typing-benchmark.ts',
          'tests/e2e/terminal/readiness/restored-terminal-input-readiness.ts',
          'tests/e2e/terminal/readiness/startup-exec-readiness-oracle.ts',
          'tests/e2e/terminal/remote-hosts/host-session-tabs.ts',
          'tests/e2e/terminal/remote-hosts/paired-desktop-server-terminal-tab.ts',
          'tests/e2e/terminal/remote-hosts/paired-host-terminal.ts',
          'tests/e2e/terminal/remote-hosts/remote-terminal-lifecycle-observer.ts',
          'tests/e2e/terminal/remote-hosts/streaming-terminal-cleanup.ts',
          'tests/e2e/terminal/remote-layout/remote-session-bulk-open-fixture.ts',
          'tests/e2e/terminal/remote-layout/remote-session-bulk-open-oracle.ts',
          'tests/e2e/terminal/remote-parking/host-created-terminal-retention-oracle.ts',
          'tests/e2e/terminal/remote-parking/paired-terminal-cold-activation-observation.ts',
          'tests/e2e/terminal/remote-parking/paired-terminal-cold-activation-oracle.ts',
          'tests/e2e/terminal/remote-parking/paired-terminal-hidden-output-oracle.ts',
          'tests/e2e/terminal/remote-parking/paired-terminal-parking-fixture.ts',
          'tests/e2e/terminal/remote-parking/paired-terminal-parking-oracle.ts',
          'tests/e2e/terminal/remote-parking/paired-terminal-title-fanout-oracle.ts',
          'tests/e2e/terminal/remote-reconnect/paired-terminal-restart-renderer-probes.ts',
          'tests/e2e/terminal/rendering/terminal-inline-image-proof.ts',
          'tests/e2e/terminal/rendering/xterm-render-dimensions.ts',
          'tests/e2e/terminal/resource-management/resource-manager-visible-fixture.ts',
          'tests/e2e/terminal/retention/terminal-hidden-parking.ts',
          'tests/e2e/terminal/retention/terminal-host-focus-storm-oracle.ts',
          'tests/e2e/terminal/retention/terminal-restart-persistence.ts',
          'tests/e2e/workspaces/repository-fixtures/git-status-retry-barrier.ts',
          'tests/e2e/workspaces/repository-fixtures/repo-with-workspaces.ts',
          'tests/e2e/workspaces/repository-fixtures/seeded-ssh-workspaces.ts',
          'tests/e2e/workspaces/repository-fixtures/seeded-test-repo.ts',
          'tests/e2e/workspaces/repository-fixtures/worktree-registration.ts',
          'tests/e2e/workspaces/sidebar/sidebar-inputs-build.ts',
          'tests/e2e/workspaces/sidebar/sidebar-project-dialog.ts',
          'tests/e2e/workspaces/sidebar/sidebar-project-visibility.ts',
          'tests/e2e/workspaces/sidebar/sidebar-setup-prompt.ts',
          'tests/e2e/workspaces/sleep/slept-workspace-probe.ts'
        ].includes(file) &&
          [...specs].some((spec) => MANAGED_SSH_E2E_SPECS.includes(spec))) ||
        file === '.github/workflows/e2e.yml' ||
        file === '.github/scripts/prepare-ubuntu-apt.sh' ||
        file === 'config/scripts/ci/e2e-selection/ci-e2e-job-selection.mjs'
    )
  ) {
    MANAGED_SSH_E2E_SPECS.forEach((spec) => specs.add(spec))
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
    (spec) => spec !== 'tests/e2e/terminal/ime/terminal-ibus-hangul-native.spec.ts'
  )
}

export function hasWslSourceChange(changedPaths) {
  const route = PR_E2E_SOURCE_ROUTES.find(
    (candidate) => candidate.id === 'terminal.windows-wsl-launch-and-paste'
  )
  return changedPaths.some(route.matches)
}

/** A route naming a deleted spec fails every later PR that touches its sources, so refuse it here. */
function missingRouteSpecs() {
  const specs = [...new Set(PR_E2E_SOURCE_ROUTES.flatMap((route) => route.specs))]
  // CI's sparse checkout omits tests/e2e/, so ask the index rather than the disk.
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z', '--', ...specs], {
      cwd: resolve(import.meta.dirname, '../../../..'),
      encoding: 'utf8'
    }).split('\0')
  )
  return PR_E2E_SOURCE_ROUTES.flatMap((route) =>
    route.specs.filter((spec) => !tracked.has(spec)).map((spec) => `${route.id}: ${spec}`)
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = missingRouteSpecs()
  if (missing.length > 0) {
    console.error(
      `E2E source routes name specs that are not tracked; remove each from its route along with the spec:\n${missing.join('\n')}`
    )
    process.exit(1)
  }
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
