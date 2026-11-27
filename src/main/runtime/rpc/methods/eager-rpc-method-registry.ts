import { STATUS_METHODS } from './host-management/status'
import { DESKTOP_WINDOW_METHODS } from './host-management/desktop-window'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs/sidebar-inputs'
import { SIDEBAR_REPO_ICON_METHODS } from './sidebar-inputs/sidebar-repo-icons'
import { ORCAD_TERMINAL_CENSUS_METHODS } from './orcad/orcad-terminal-census'
import { ORCAD_MIGRATION_METHODS } from './orcad/orcad-migration'
import { SESSION_TERMINAL_SCROLLBACK_METHODS } from './terminal/session-terminal-scrollback'
import { AI_VAULT_METHODS } from './history/ai-vault'
import { REPO_METHODS } from './projects/repo'
import { WORKTREE_METHODS } from './workspaces/worktree'
import { WORKTREE_AUTO_NAME_METHODS } from './workspaces/worktree-auto-name-methods'
import { WORKSPACE_CLEANUP_RUNNER_METHODS } from './workspaces/workspace-cleanup-runner-methods'
import { WORKTREE_ARCHIVE_METHODS } from './workspaces/worktree-archive-methods'
import { AGENT_ACTIVITY_METHODS } from './workspaces/agent-activity-methods'
import { REFERENCE_METHODS } from './reference/reference'
import { TERMINAL_METHODS } from './terminal/terminal'
import { TERMINAL_ORPHAN_METHODS } from './terminal/terminal-orphan'
import { BROWSER_CORE_METHODS } from './browser/browser-core'
import { BROWSER_IDENTITY_METHODS } from './browser/browser-identity-rpc'
import { BROWSER_EXTRA_METHODS } from './browser/browser-extras'
import { BROWSER_SCREENCAST_METHODS } from './browser/browser-screencast'
import { BROWSER_GRAB_METHODS } from './browser/browser-grab'
import { BROWSER_CLIENT_HOST_METHODS } from './browser/browser-client-host'
import { DESKTOP_BROWSER_BRIDGE_RPC_METHODS } from './browser/desktop-browser-bridge'
import { BROWSER_CLIENT_FILE_CHANNEL_METHODS } from './browser/browser-client-file-channel'
import { BROWSER_NETWORK_TUNNEL_METHODS } from './browser/browser-network-tunnel'
import { ORCHESTRATION_METHODS } from './orchestration/orchestration'
import { NOTIFICATION_METHODS } from './notifications/notifications'
import { PAIRED_SERVER_ASKS_METHODS } from './paired-server-asks/paired-server-asks-methods'
import { STATS_METHODS } from './host-management/stats'
import { USAGE_ANALYTICS_METHODS } from './host-management/usage-analytics'
import { TERMINAL_DAEMON_METHODS } from './terminal/terminal-daemon'
import { ACCOUNT_METHODS } from './accounts/accounts'
import { ANTIGRAVITY_ACCOUNT_METHODS } from './accounts/antigravity-accounts'
import { ORCA_ACCOUNT_METHODS } from './orca-account'
import { USAGE_CREDENTIAL_METHODS } from './accounts/usage-credentials'
import { PREFLIGHT_METHODS } from './preflight/preflight'
import { SESSION_TAB_METHODS } from './session-tabs/session-tabs'
import { NATIVE_CHAT_METHODS } from './native-chat/native-chat'
import { FILE_METHODS } from './files/files'
import { GIT_METHODS } from './source-control/git/git'
import { GITHUB_METHODS } from './source-control/github/github'
import { SSH_METHODS } from './ssh/ssh'
import { RECIPE_VM_WAKE_METHODS } from './host-management/recipe-vm-wake'
import { ENVIRONMENT_DOCTOR_METHODS } from './host-management/environment-doctor'
import { CLIENT_UI_METHODS } from './client-state/client-ui'
import { CLIENT_EVENT_METHODS } from './client-events/client-events'
import { WORKSPACE_PORT_METHODS } from './workspace-ports/workspace-ports'
import { NETWORK_PORT_FORWARD_METHODS } from './workspace-ports/network-port-forward'
import { PLUGIN_METHODS } from './plugins/plugins'
import { PLUGIN_VIEW_METHODS } from './plugins/plugin-view'
import { PLUGIN_DEV_EMIT_METHODS } from './plugins/plugin-dev-emit'
import { PLUGIN_DEV_REQUEST_METHODS } from './plugins/plugin-dev-request'
import { PLUGIN_INSTALL_METHODS } from './plugins/plugin-install-methods'
import { CLIPBOARD_METHODS } from './clipboard/clipboard'
import { HOST_CAPABILITY_METHODS } from './host-management/host-capabilities'
import { MOBILE_WEB_BUNDLE_METHODS } from './mobile-delivery/mobile-web-bundle'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './client-events/runtime-client-capabilities'
import { PAIRING_METHODS } from './pairing/pairing'
import { MOBILE_RELAY_HOSTS_METHODS } from './pairing/mobile-relay-hosts'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './mobile-delivery/mobile-project-sections'
import { UPDATER_METHODS } from './updater/updater'
import { AGENT_SESSION_METHODS } from './terminal/agent-session'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-sessions/structured-agent-session'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-sessions/attachments/structured-agent-session-attachments'
import { STRUCTURED_AGENT_SESSION_VISUAL_METHODS } from './structured-sessions/attachments/structured-agent-session-visual'
import { STRUCTURED_AGENT_SESSION_AGENTS_METHODS } from './structured-sessions/catalog/structured-agent-session-agents'
import { MANAGED_RUNTIME_INSTALL_METHODS } from './host-management/managed-runtime-install'
import { AGENT_CLI_UPDATE_METHODS } from './host-management/agent-cli-update'
import { AGENT_HOOK_METHODS } from './agent-hooks/agent-hooks'
import { AGENT_LAUNCH_METHODS } from './agent-launch/agent-launch'
import { AGENT_CONVERSATION_METHODS } from './agent-conversations/agent-conversation-methods'
import {
  LAYOUT_APPLY_METHODS,
  LAYOUT_VIEW_REPORT_METHODS,
  WORKSPACE_LAYOUT_METHODS
} from './workspace-layout/workspace-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import { prefixRpcMethodGroup, type LazyRpcMethodGroup } from '../lazy-rpc-method-group'

export const EAGER_CORE_RPC_METHODS = [
  ...STATUS_METHODS,
  ...PAIRED_SERVER_ASKS_METHODS,
  ...DESKTOP_WINDOW_METHODS,
  ...ORCAD_TERMINAL_CENSUS_METHODS,
  ...ORCAD_MIGRATION_METHODS,
  ...SESSION_TERMINAL_SCROLLBACK_METHODS,
  ...AGENT_HOOK_METHODS,
  ...AI_VAULT_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...WORKTREE_AUTO_NAME_METHODS,
  ...WORKSPACE_CLEANUP_RUNNER_METHODS,
  ...WORKTREE_ARCHIVE_METHODS,
  ...AGENT_ACTIVITY_METHODS,
  ...REFERENCE_METHODS,
  ...AGENT_SESSION_METHODS,
  ...STRUCTURED_AGENT_SESSION_METHODS,
  ...STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS,
  ...STRUCTURED_AGENT_SESSION_VISUAL_METHODS,
  ...STRUCTURED_AGENT_SESSION_AGENTS_METHODS,
  ...MANAGED_RUNTIME_INSTALL_METHODS,
  ...AGENT_CLI_UPDATE_METHODS,
  ...AGENT_LAUNCH_METHODS,
  ...AGENT_CONVERSATION_METHODS
] as const

export const EAGER_SERVICE_RPC_METHODS = [
  ...TERMINAL_METHODS,
  ...TERMINAL_ORPHAN_METHODS,
  ...BROWSER_CORE_METHODS,
  ...BROWSER_IDENTITY_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_GRAB_METHODS,
  ...BROWSER_EXTRA_METHODS,
  ...BROWSER_CLIENT_HOST_METHODS,
  ...DESKTOP_BROWSER_BRIDGE_RPC_METHODS,
  ...BROWSER_CLIENT_FILE_CHANNEL_METHODS,
  ...BROWSER_NETWORK_TUNNEL_METHODS,
  ...NETWORK_PORT_FORWARD_METHODS,
  ...ORCHESTRATION_METHODS,
  ...NOTIFICATION_METHODS,
  ...STATS_METHODS,
  ...USAGE_ANALYTICS_METHODS,
  ...TERMINAL_DAEMON_METHODS,
  ...ACCOUNT_METHODS,
  ...ANTIGRAVITY_ACCOUNT_METHODS,
  ...ORCA_ACCOUNT_METHODS,
  ...USAGE_CREDENTIAL_METHODS,
  ...PREFLIGHT_METHODS,
  ...SESSION_TAB_METHODS,
  ...WORKSPACE_LAYOUT_METHODS,
  // Switch point: a window-owned build registers no layout command.
  ...(ORCA_LAYOUT_OWNER_IS_MAIN ? [...LAYOUT_APPLY_METHODS, ...LAYOUT_VIEW_REPORT_METHODS] : []),
  ...NATIVE_CHAT_METHODS,
  ...FILE_METHODS,
  ...GIT_METHODS,
  ...GITHUB_METHODS,
  ...SSH_METHODS,
  ...RECIPE_VM_WAKE_METHODS,
  ...ENVIRONMENT_DOCTOR_METHODS,
  ...WORKSPACE_PORT_METHODS,
  ...PLUGIN_METHODS,
  ...PLUGIN_VIEW_METHODS,
  ...PLUGIN_DEV_EMIT_METHODS,
  ...PLUGIN_DEV_REQUEST_METHODS,
  ...PLUGIN_INSTALL_METHODS,
  ...CLIPBOARD_METHODS,
  ...HOST_CAPABILITY_METHODS,
  ...MOBILE_WEB_BUNDLE_METHODS,
  ...RUNTIME_CLIENT_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  ...CLIENT_UI_METHODS,
  ...PAIRING_METHODS,
  ...MOBILE_RELAY_HOSTS_METHODS,
  ...MOBILE_PROJECT_SECTIONS_METHODS,
  // Switch point: a window-fed build publishes no sidebar input.
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN ? SIDEBAR_INPUT_METHODS : []),
  ...SIDEBAR_REPO_ICON_METHODS,
  ...UPDATER_METHODS
] as const

export const EAGER_RPC_METHODS = [...EAGER_CORE_RPC_METHODS, ...EAGER_SERVICE_RPC_METHODS] as const

export const DEFAULT_LAZY_RPC_METHOD_GROUPS: readonly LazyRpcMethodGroup[] = [
  prefixRpcMethodGroup(
    ['bots.', 'mcpServers.', 'webhooks.'],
    async () => (await import('./bot-rpc-methods')).BOT_RPC_METHODS,
    { exactNames: ['worktree.releaseBotHome'] }
  ),
  prefixRpcMethodGroup(['connector.'], async () => {
    const [{ CONNECTOR_METHODS }, { CONNECTOR_SLACK_MIRROR_METHODS }] = await Promise.all([
      import('./connectors/connector'),
      import('./connectors/connector-slack-mirror')
    ])
    return [...CONNECTOR_METHODS, ...CONNECTOR_SLACK_MIRROR_METHODS]
  }),
  prefixRpcMethodGroup(['google.'], async () => {
    const [
      { GOOGLE_METHODS },
      { GOOGLE_READ_METHODS },
      { GOOGLE_FILES_METHODS },
      { GOOGLE_WRITE_METHODS }
    ] = await Promise.all([
      import('./google'),
      import('./google-read'),
      import('./google-files'),
      import('./google-write')
    ])
    return [
      ...GOOGLE_METHODS,
      ...GOOGLE_READ_METHODS,
      ...GOOGLE_FILES_METHODS,
      ...GOOGLE_WRITE_METHODS
    ]
  }),
  prefixRpcMethodGroup(
    ['emulator.'],
    async () => (await import('./emulator/emulator')).EMULATOR_METHODS
  ),
  prefixRpcMethodGroup(['speech.'], async () => (await import('./speech/speech')).SPEECH_METHODS),
  prefixRpcMethodGroup(
    ['gitlab.'],
    async () => (await import('./source-control/gitlab/gitlab')).GITLAB_METHODS
  ),
  prefixRpcMethodGroup(
    ['hostedReview.'],
    async () => (await import('./source-control/reviews/hosted-review')).HOSTED_REVIEW_METHODS
  ),
  prefixRpcMethodGroup(['linear.'], async () => {
    const [{ LINEAR_METHODS }, { LINEAR_AGENT_ACCESS_METHODS }] = await Promise.all([
      import('./integrations/linear/linear'),
      import('./integrations/linear/linear-agent-access')
    ])
    return [...LINEAR_METHODS, ...LINEAR_AGENT_ACCESS_METHODS]
  }),
  prefixRpcMethodGroup(
    ['jira.'],
    async () => (await import('./integrations/jira/jira')).JIRA_METHODS,
    { streamingNames: ['jira.attachmentImage', 'jira.getIssueStream', 'jira.issueCommentsStream'] }
  ),
  prefixRpcMethodGroup(
    ['computer.'],
    async () => (await import('./computer/computer')).COMPUTER_METHODS
  ),
  prefixRpcMethodGroup(['automation.', 'runtime.automaticWork.'], async () => {
    const [{ AUTOMATION_METHODS }, { AUTOMATIC_WORK_METHODS }] = await Promise.all([
      import('./automations/automations'),
      import('./automations/automatic-work')
    ])
    return [...AUTOMATION_METHODS, ...AUTOMATIC_WORK_METHODS]
  }),
  prefixRpcMethodGroup(
    ['artifacts.'],
    async () => (await import('./artifacts/artifacts')).ARTIFACT_METHODS
  ),
  prefixRpcMethodGroup(['skills.'], async () => (await import('./skills/skills')).SKILL_METHODS),
  prefixRpcMethodGroup(
    ['linkPreview.'],
    async () => (await import('./link-preview/link-preview')).LINK_PREVIEW_METHODS
  ),
  prefixRpcMethodGroup(
    ['diagnostics.'],
    async () => (await import('./host-management/diagnostics')).DIAGNOSTICS_METHODS
  ),
  prefixRpcMethodGroup(
    ['managedServer.'],
    async () => (await import('./host-management/managed-server')).MANAGED_SERVER_METHODS
  )
]

export const DEFAULT_RPC_DISPATCH_CONFIG = {
  methods: EAGER_RPC_METHODS,
  lazyGroups: DEFAULT_LAZY_RPC_METHOD_GROUPS
} as const
