import { ORCAD_TERMINAL_CENSUS_METHOD } from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import { AUTO_NAME_RPC_METHODS } from '../../../../shared/worktree/branch-auto-rename-attempt'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../../shared/agent-session/agent-discovery/agent-session-registered-agents'
import { AGENT_SESSION_AVAILABILITY_METHOD } from '../../../../shared/agent-session/agent-discovery/agent-session-agent-availability'
import { prefixRpcMethodGroup, type LazyRpcMethodGroup } from '../lazy-rpc-method-group'
import { LAZY_BROWSER_RPC_METHOD_GROUPS } from './lazy-browser-rpc-method-groups'
import { LAZY_INTEGRATION_RPC_METHOD_GROUPS } from './lazy-integration-rpc-method-groups'

export const DEFAULT_LAZY_RPC_METHOD_GROUPS: readonly LazyRpcMethodGroup[] = [
  ...LAZY_INTEGRATION_RPC_METHOD_GROUPS,
  prefixRpcMethodGroup(['ssh.'], async () => (await import('./ssh/ssh')).SSH_METHODS),
  prefixRpcMethodGroup(['plugins.'], async () => {
    const [
      { PLUGIN_METHODS },
      { PLUGIN_VIEW_METHODS },
      { PLUGIN_DEV_EMIT_METHODS },
      { PLUGIN_DEV_REQUEST_METHODS },
      { PLUGIN_INSTALL_METHODS }
    ] = await Promise.all([
      import('./plugins/plugins'),
      import('./plugins/plugin-view'),
      import('./plugins/plugin-dev-emit'),
      import('./plugins/plugin-dev-request'),
      import('./plugins/plugin-install-methods')
    ])
    return [
      ...PLUGIN_METHODS,
      ...PLUGIN_VIEW_METHODS,
      ...PLUGIN_DEV_EMIT_METHODS,
      ...PLUGIN_DEV_REQUEST_METHODS,
      ...PLUGIN_INSTALL_METHODS
    ]
  }),
  prefixRpcMethodGroup(
    ['updater.'],
    async () => (await import('./updater/updater')).UPDATER_METHODS
  ),
  prefixRpcMethodGroup(
    ['aiVault.'],
    async () => (await import('./history/ai-vault')).AI_VAULT_METHODS
  ),
  prefixRpcMethodGroup(
    ['preflight.'],
    async () => (await import('./preflight/preflight')).PREFLIGHT_METHODS
  ),
  prefixRpcMethodGroup(
    ['workspacePorts.'],
    async () => (await import('./workspace-ports/workspace-ports')).WORKSPACE_PORT_METHODS
  ),
  prefixRpcMethodGroup(
    [],
    async () =>
      (await import('./workspace-ports/network-port-forward')).NETWORK_PORT_FORWARD_METHODS,
    { exactNames: ['network.portForward'], streamingNames: ['network.portForward'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./host-management/recipe-vm-wake')).RECIPE_VM_WAKE_METHODS,
    { exactNames: ['runtimeEnvironment.wakeRecipeVm'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./host-management/environment-doctor')).ENVIRONMENT_DOCTOR_METHODS,
    { exactNames: ['environment.doctor'] }
  ),
  prefixRpcMethodGroup(
    ['managedRuntime.'],
    async () =>
      (await import('./host-management/managed-runtime-install')).MANAGED_RUNTIME_INSTALL_METHODS,
    { streamingNames: ['managedRuntime.subscribe'] }
  ),
  prefixRpcMethodGroup(
    ['agentCliUpdate.'],
    async () => (await import('./host-management/agent-cli-update')).AGENT_CLI_UPDATE_METHODS,
    { streamingNames: ['agentCliUpdate.subscribe'] }
  ),
  prefixRpcMethodGroup(
    ['pairing.'],
    async () => (await import('./pairing/pairing')).PAIRING_METHODS,
    { exactNames: ['host.peerDesktops', 'host.declareClient', 'host.declareAccount'] }
  ),
  prefixRpcMethodGroup(['mobileRelay.', 'mobileWeb.'], async () => {
    const [
      { MOBILE_RELAY_HOSTS_METHODS },
      { MOBILE_PROJECT_SECTIONS_METHODS },
      { MOBILE_WEB_BUNDLE_METHODS }
    ] = await Promise.all([
      import('./pairing/mobile-relay-hosts'),
      import('./mobile-delivery/mobile-project-sections'),
      import('./mobile-delivery/mobile-web-bundle')
    ])
    return [
      ...MOBILE_RELAY_HOSTS_METHODS,
      ...MOBILE_PROJECT_SECTIONS_METHODS,
      ...MOBILE_WEB_BUNDLE_METHODS
    ]
  }),
  prefixRpcMethodGroup(
    ['orchestration.'],
    async () => (await import('./orchestration/orchestration')).ORCHESTRATION_METHODS,
    {
      streamingNames: [
        'orchestration.crewSubscribe',
        'orchestration.workerApprovalsSubscribe',
        'orchestration.workerDockSubscribe'
      ]
    }
  ),
  ...LAZY_BROWSER_RPC_METHOD_GROUPS,
  prefixRpcMethodGroup(
    ['accounts.'],
    async () => {
      const [{ ACCOUNT_METHODS }, { ANTIGRAVITY_ACCOUNT_METHODS }, { USAGE_CREDENTIAL_METHODS }] =
        await Promise.all([
          import('./accounts/accounts'),
          import('./accounts/antigravity-accounts'),
          import('./accounts/usage-credentials')
        ])
      return [...ACCOUNT_METHODS, ...ANTIGRAVITY_ACCOUNT_METHODS, ...USAGE_CREDENTIAL_METHODS]
    },
    { streamingNames: ['accounts.subscribe', 'accounts.antigravityChatSignInSubscribe'] }
  ),
  prefixRpcMethodGroup(
    ['orcaAccount.'],
    async () => (await import('./orca-account')).ORCA_ACCOUNT_METHODS,
    { streamingNames: ['orcaAccount.subscribe'] }
  ),
  prefixRpcMethodGroup(
    ['github.'],
    async () => (await import('./source-control/github/github')).GITHUB_METHODS
  ),
  prefixRpcMethodGroup(
    ['stats.'],
    async () => (await import('./host-management/stats')).STATS_METHODS
  ),
  prefixRpcMethodGroup(
    ['usage.'],
    async () => (await import('./host-management/usage-analytics')).USAGE_ANALYTICS_METHODS
  ),
  prefixRpcMethodGroup(
    ['pairedServerAsks.'],
    async () =>
      (await import('./paired-server-asks/paired-server-asks-methods')).PAIRED_SERVER_ASKS_METHODS
  ),
  prefixRpcMethodGroup(
    ['reference.'],
    async () => (await import('./reference/reference')).REFERENCE_METHODS
  ),
  prefixRpcMethodGroup(
    ['workspaceCleanup.'],
    async () =>
      (await import('./workspaces/workspace-cleanup-runner-methods'))
        .WORKSPACE_CLEANUP_RUNNER_METHODS
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./workspaces/worktree-archive-methods')).WORKTREE_ARCHIVE_METHODS,
    { exactNames: ['worktree.archive', 'worktree.restore'] }
  ),
  prefixRpcMethodGroup(
    ['orcad.migration.'],
    async () => (await import('./orcad/orcad-migration')).ORCAD_MIGRATION_METHODS
  ),
  prefixRpcMethodGroup(['files.'], async () => (await import('./files/files')).FILE_METHODS, {
    streamingNames: ['files.watch']
  }),
  prefixRpcMethodGroup(
    ['git.'],
    async () => (await import('./source-control/git/git')).GIT_METHODS
  ),
  prefixRpcMethodGroup(
    ['clipboard.'],
    async () => (await import('./clipboard/clipboard')).CLIPBOARD_METHODS
  ),
  prefixRpcMethodGroup(
    ['notifications.'],
    async () => (await import('./notifications/notifications')).NOTIFICATION_METHODS,
    { streamingNames: ['notifications.subscribe'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./agent-launch/agent-launch')).AGENT_LAUNCH_METHODS,
    { exactNames: ['agent.launch', 'agent.launchReplay'] }
  ),
  prefixRpcMethodGroup(
    ['agent.'],
    async () =>
      (await import('./agent-conversations/agent-conversation-methods')).AGENT_CONVERSATION_METHODS
  ),
  prefixRpcMethodGroup(
    ['nativeChat.'],
    async () => (await import('./native-chat/native-chat')).NATIVE_CHAT_METHODS,
    { streamingNames: ['nativeChat.subscribe'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () =>
      (await import('./structured-sessions/catalog/structured-agent-session-agents'))
        .STRUCTURED_AGENT_SESSION_AGENTS_METHODS,
    {
      exactNames: [AGENT_SESSION_AGENTS_METHOD, AGENT_SESSION_AVAILABILITY_METHOD],
      streamingNames: [AGENT_SESSION_AVAILABILITY_METHOD]
    }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./orcad/orcad-terminal-census')).ORCAD_TERMINAL_CENSUS_METHODS,
    { exactNames: [ORCAD_TERMINAL_CENSUS_METHOD] }
  ),
  prefixRpcMethodGroup(
    [],
    async () =>
      (await import('./terminal/session-terminal-scrollback')).SESSION_TERMINAL_SCROLLBACK_METHODS,
    { exactNames: ['session.readTerminalScrollback'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () =>
      (await import('./workspaces/worktree-auto-name-methods')).WORKTREE_AUTO_NAME_METHODS,
    { exactNames: Object.values(AUTO_NAME_RPC_METHODS) }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./terminal/terminal-orphan')).TERMINAL_ORPHAN_METHODS,
    { exactNames: ['terminal.adoptOrphans'] }
  ),
  prefixRpcMethodGroup(
    [],
    async () => (await import('./terminal/agent-session')).AGENT_SESSION_METHODS,
    { exactNames: ['terminal.ensureAgentSession', 'terminal.createAgentSession'] }
  ),
  prefixRpcMethodGroup(
    ['agentSessionAttachment.'],
    async () =>
      (await import('./structured-sessions/attachments/structured-agent-session-attachments'))
        .STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
  ),
  prefixRpcMethodGroup(
    [],
    async () =>
      (await import('./structured-sessions/attachments/structured-agent-session-visual'))
        .STRUCTURED_AGENT_SESSION_VISUAL_METHODS,
    { exactNames: ['agentSession.readVisual'] }
  ),
  prefixRpcMethodGroup(
    ['agentSession.'],
    async () =>
      (await import('./structured-sessions/structured-agent-session'))
        .STRUCTURED_AGENT_SESSION_METHODS,
    {
      streamingNames: [
        'agentSession.subscribe',
        'agentSession.subscribeStatus',
        'agentSession.subscribeTurnCompletions'
      ]
    }
  ),
  prefixRpcMethodGroup(
    ['terminalDaemon.'],
    async () => (await import('./terminal/terminal-daemon')).TERMINAL_DAEMON_METHODS
  ),
  prefixRpcMethodGroup(
    ['agentActivity.'],
    async () => (await import('./workspaces/agent-activity-methods')).AGENT_ACTIVITY_METHODS
  ),
  prefixRpcMethodGroup(
    ['ui.', 'settings.'],
    async () => (await import('./client-state/client-ui')).CLIENT_UI_METHODS
  )
]
