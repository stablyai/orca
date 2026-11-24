import { STATUS_METHODS } from './host-management/status'
import { DESKTOP_WINDOW_METHODS } from './host-management/desktop-window'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs/sidebar-inputs'
import { SIDEBAR_REPO_ICON_METHODS } from './sidebar-inputs/sidebar-repo-icons'
import { ORCAD_TERMINAL_CENSUS_METHODS } from './orcad/orcad-terminal-census'
import { ORCAD_MIGRATION_METHODS } from './orcad/orcad-migration'
import { SESSION_TERMINAL_SCROLLBACK_METHODS } from './terminal/session-terminal-scrollback'
import { AI_VAULT_METHODS } from './history/ai-vault'
import { AUTOMATION_METHODS } from './automations/automations'
import { REPO_METHODS } from './projects/repo'
import { WORKTREE_METHODS } from './workspaces/worktree'
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
import { DIAGNOSTICS_METHODS } from './host-management/diagnostics'
import { TERMINAL_DAEMON_METHODS } from './terminal/terminal-daemon'
import { ACCOUNT_METHODS } from './accounts/accounts'
import { ANTIGRAVITY_ACCOUNT_METHODS } from './accounts/antigravity-accounts'
import { ORCA_ACCOUNT_METHODS } from './orca-account'
import { GOOGLE_METHODS } from './google'
import { GOOGLE_READ_METHODS } from './google-read'
import { GOOGLE_FILES_METHODS } from './google-files'
import { GOOGLE_WRITE_METHODS } from './google-write'
import { USAGE_CREDENTIAL_METHODS } from './accounts/usage-credentials'
import { PREFLIGHT_METHODS } from './preflight/preflight'
import { COMPUTER_METHODS } from './computer/computer'
import { SESSION_TAB_METHODS } from './session-tabs/session-tabs'
import { NATIVE_CHAT_METHODS } from './native-chat/native-chat'
import { FILE_METHODS } from './files/files'
import { GIT_METHODS } from './source-control/git/git'
import { GITHUB_METHODS } from './source-control/github/github'
import { GITLAB_METHODS } from './source-control/gitlab/gitlab'
import { HOSTED_REVIEW_METHODS } from './source-control/reviews/hosted-review'
import { LINEAR_METHODS } from './integrations/linear/linear'
import { LINEAR_AGENT_ACCESS_METHODS } from './integrations/linear/linear-agent-access'
import { JIRA_METHODS } from './integrations/jira/jira'
import { SSH_METHODS } from './ssh/ssh'
import { MANAGED_SERVER_METHODS } from './host-management/managed-server'
import { RECIPE_VM_WAKE_METHODS } from './host-management/recipe-vm-wake'
import { ENVIRONMENT_DOCTOR_METHODS } from './host-management/environment-doctor'
import { SPEECH_METHODS } from './speech/speech'
import { CLIENT_UI_METHODS } from './client-state/client-ui'
import { CLIENT_EVENT_METHODS } from './client-events/client-events'
import { WORKSPACE_PORT_METHODS } from './workspace-ports/workspace-ports'
import { NETWORK_PORT_FORWARD_METHODS } from './workspace-ports/network-port-forward'
import { LINK_PREVIEW_METHODS } from './link-preview/link-preview'
import { PLUGIN_METHODS } from './plugins/plugins'
import { PLUGIN_VIEW_METHODS } from './plugins/plugin-view'
import { PLUGIN_DEV_EMIT_METHODS } from './plugins/plugin-dev-emit'
import { PLUGIN_DEV_REQUEST_METHODS } from './plugins/plugin-dev-request'
import { PLUGIN_INSTALL_METHODS } from './plugins/plugin-install-methods'
import { SKILL_METHODS } from './skills/skills'
import { CLIPBOARD_METHODS } from './clipboard/clipboard'
import { HOST_CAPABILITY_METHODS } from './host-management/host-capabilities'
import { MOBILE_WEB_BUNDLE_METHODS } from './mobile-delivery/mobile-web-bundle'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './client-events/runtime-client-capabilities'
import { EMULATOR_METHODS } from './emulator/emulator'
import { PAIRING_METHODS } from './pairing/pairing'
import { MOBILE_RELAY_HOSTS_METHODS } from './pairing/mobile-relay-hosts'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './mobile-delivery/mobile-project-sections'
import { UPDATER_METHODS } from './updater/updater'
import { AUTOMATIC_WORK_METHODS } from './automations/automatic-work'
import { AGENT_SESSION_METHODS } from './terminal/agent-session'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-sessions/structured-agent-session'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-sessions/attachments/structured-agent-session-attachments'
import { STRUCTURED_AGENT_SESSION_VISUAL_METHODS } from './structured-sessions/attachments/structured-agent-session-visual'
import { STRUCTURED_AGENT_SESSION_AGENTS_METHODS } from './structured-sessions/catalog/structured-agent-session-agents'
import { MANAGED_RUNTIME_INSTALL_METHODS } from './host-management/managed-runtime-install'
import { AGENT_CLI_UPDATE_METHODS } from './host-management/agent-cli-update'
import { ARTIFACT_METHODS } from './artifacts/artifacts'
import { AGENT_HOOK_METHODS } from './agent-hooks/agent-hooks'
import { AGENT_LAUNCH_METHODS } from './agent-launch/agent-launch'
import { AGENT_CONVERSATION_METHODS } from './agent-conversations/agent-conversation-methods'
import { CONNECTOR_METHODS } from './connectors/connector'
import { CONNECTOR_SLACK_MIRROR_METHODS } from './connectors/connector-slack-mirror'
import { BOT_GROUP_METHODS } from './bot-groups'
import { BOT_METHODS } from './bots'
import { BOT_TAKE_OVER_METHOD } from './bots-take-over'
import { BOT_RUN_SEND_AGAIN_METHOD } from './bots-run-send-again'
import { BOT_ACCESS_METHODS } from './bots-access'
import { BOT_SLACK_METHODS } from './bots-slack'
import { BOT_LINEAR_METHODS } from './bots-linear'
import { BOT_GITHUB_METHODS } from './bots-github'
import { BOT_CONNECT_METHODS } from './bots-connect'
import { BOT_LOOK_AROUND_METHODS } from './bots-look-around'
import { BOT_TIDY_UP_METHODS } from './bots-tidy-up'
import { BOT_WORK_METHODS } from './bots-work'
import { BOT_ITEMS_METHODS } from './bots-items'
import { BOT_CONNECTOR_OFFER_METHOD } from './bots-connector-offer'
import { GOOGLE_SETUP_METHODS } from './bots-google-setup'
import { GOOGLE_SETUP_SAVED_KEY_METHODS } from './bots-google-setup-saved-key'
import { BOT_REQUEST_OUTCOME_METHOD } from './bots-request-outcome'
import { WORKTREE_RELEASE_BOT_HOME_METHOD } from './bots-home-release'
import { BOT_CREATE_OFFER_METHOD } from './bots-create-offer'
import { BOT_TEMPLATE_METHODS } from './bots-templates'
import { BOT_IMPORT_METHODS } from './bots-import'
import { BOT_SHARE_METHODS } from './bots-share'
import { BOT_TEAM_SHARES_METHODS } from './bots-team-shares'
import { BOT_SHARE_RECEIVE_METHODS } from './bots-share-receive'
import { BOT_CONNECTORS_METHOD } from './bots-connectors'
import { BOT_TOOLS_METHODS } from './bots-tools'
import { BOT_TOOLS_OWNED_SIGN_IN_METHODS } from './bots-tools-owned-sign-in'
import { BOT_COMPOSIO_METHODS } from './bots-composio'
import { BOT_COMPOSIO_EVENTS_METHODS } from './bots-composio-events'
import { WEBHOOK_METHODS } from './webhooks'
import {
  LAYOUT_APPLY_METHODS,
  LAYOUT_VIEW_REPORT_METHODS,
  WORKSPACE_LAYOUT_METHODS
} from './workspace-layout/workspace-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-list/feed/sidebar-inputs-switch'

// Keep registration order and the full RPC/security surface visible in one manifest.
const CORE_RPC_METHODS = [
  ...STATUS_METHODS,
  ...PAIRED_SERVER_ASKS_METHODS,
  ...DESKTOP_WINDOW_METHODS,
  ...ORCAD_TERMINAL_CENSUS_METHODS,
  ...ORCAD_MIGRATION_METHODS,
  ...SESSION_TERMINAL_SCROLLBACK_METHODS,
  ...AGENT_HOOK_METHODS,
  ...AI_VAULT_METHODS,
  ...ARTIFACT_METHODS,
  ...AUTOMATION_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
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
  ...AGENT_CONVERSATION_METHODS,
  ...CONNECTOR_METHODS,
  ...CONNECTOR_SLACK_MIRROR_METHODS
] as const

const BOT_RPC_METHODS = [
  ...BOT_METHODS,
  BOT_TAKE_OVER_METHOD,
  BOT_RUN_SEND_AGAIN_METHOD,
  ...BOT_GROUP_METHODS,
  ...BOT_ACCESS_METHODS,
  ...BOT_SLACK_METHODS,
  ...BOT_LINEAR_METHODS,
  ...BOT_GITHUB_METHODS,
  ...BOT_CONNECT_METHODS,
  ...BOT_LOOK_AROUND_METHODS,
  ...BOT_TIDY_UP_METHODS,
  ...BOT_WORK_METHODS,
  ...BOT_ITEMS_METHODS,
  BOT_CONNECTOR_OFFER_METHOD,
  ...GOOGLE_SETUP_METHODS,
  ...GOOGLE_SETUP_SAVED_KEY_METHODS,
  BOT_REQUEST_OUTCOME_METHOD,
  WORKTREE_RELEASE_BOT_HOME_METHOD,
  BOT_CREATE_OFFER_METHOD,
  ...BOT_TEMPLATE_METHODS,
  ...BOT_IMPORT_METHODS,
  ...BOT_SHARE_METHODS,
  ...BOT_TEAM_SHARES_METHODS,
  ...BOT_SHARE_RECEIVE_METHODS,
  BOT_CONNECTORS_METHOD,
  ...BOT_TOOLS_METHODS,
  ...BOT_TOOLS_OWNED_SIGN_IN_METHODS,
  ...BOT_COMPOSIO_METHODS,
  ...BOT_COMPOSIO_EVENTS_METHODS,
  ...WEBHOOK_METHODS
] as const

const SERVICE_RPC_METHODS = [
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
  ...DIAGNOSTICS_METHODS,
  ...TERMINAL_DAEMON_METHODS,
  ...ACCOUNT_METHODS,
  ...ANTIGRAVITY_ACCOUNT_METHODS,
  ...ORCA_ACCOUNT_METHODS,
  ...GOOGLE_METHODS,
  ...GOOGLE_READ_METHODS,
  ...GOOGLE_FILES_METHODS,
  ...GOOGLE_WRITE_METHODS,
  ...USAGE_CREDENTIAL_METHODS,
  ...PREFLIGHT_METHODS,
  ...COMPUTER_METHODS,
  ...SESSION_TAB_METHODS,
  ...WORKSPACE_LAYOUT_METHODS,
  // Switch point: a window-owned build registers no layout command.
  ...(ORCA_LAYOUT_OWNER_IS_MAIN ? [...LAYOUT_APPLY_METHODS, ...LAYOUT_VIEW_REPORT_METHODS] : []),
  ...NATIVE_CHAT_METHODS,
  ...FILE_METHODS,
  ...GIT_METHODS,
  ...GITHUB_METHODS,
  ...GITLAB_METHODS,
  ...HOSTED_REVIEW_METHODS,
  ...LINEAR_METHODS,
  ...LINEAR_AGENT_ACCESS_METHODS,
  ...JIRA_METHODS,
  ...SSH_METHODS,
  ...MANAGED_SERVER_METHODS,
  ...RECIPE_VM_WAKE_METHODS,
  ...ENVIRONMENT_DOCTOR_METHODS,
  ...SPEECH_METHODS,
  ...WORKSPACE_PORT_METHODS,
  ...LINK_PREVIEW_METHODS,
  ...PLUGIN_METHODS,
  ...PLUGIN_VIEW_METHODS,
  ...PLUGIN_DEV_EMIT_METHODS,
  ...PLUGIN_DEV_REQUEST_METHODS,
  ...PLUGIN_INSTALL_METHODS,
  ...SKILL_METHODS,
  ...CLIPBOARD_METHODS,
  ...HOST_CAPABILITY_METHODS,
  ...MOBILE_WEB_BUNDLE_METHODS,
  ...RUNTIME_CLIENT_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  ...CLIENT_UI_METHODS,
  ...EMULATOR_METHODS,
  ...PAIRING_METHODS,
  ...MOBILE_RELAY_HOSTS_METHODS,
  ...MOBILE_PROJECT_SECTIONS_METHODS,
  // Switch point: a window-fed build publishes no sidebar input.
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN ? SIDEBAR_INPUT_METHODS : []),
  ...SIDEBAR_REPO_ICON_METHODS,
  ...UPDATER_METHODS,
  ...AUTOMATIC_WORK_METHODS
] as const

type ConcatMethods<A extends readonly unknown[], B extends readonly unknown[]> = readonly [
  ...A,
  ...B
]

// Named segments keep declaration serialization bounded without erasing method params.
export const ALL_RPC_METHODS: ConcatMethods<
  ConcatMethods<typeof CORE_RPC_METHODS, typeof BOT_RPC_METHODS>,
  typeof SERVICE_RPC_METHODS
> = [...CORE_RPC_METHODS, ...BOT_RPC_METHODS, ...SERVICE_RPC_METHODS] as const
