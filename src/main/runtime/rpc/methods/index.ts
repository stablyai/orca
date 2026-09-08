import { MOBILE_WEB_SESSION_METHODS } from './mobile-web-session'
import { MOBILE_WEB_SESSION_STREAM_METHODS } from './mobile-web-session-stream'
import { MOBILE_WEB_WORKSPACE_STREAM_METHODS } from './mobile-web-workspace-stream'
import { MOBILE_WEB_SESSION_CAPABILITIES_METHOD } from './mobile-web-session-capabilities'
import { MOBILE_WEB_SESSION_QUICK_COMMAND_METHODS } from './mobile-web-session-quick-commands'
import { MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD } from './mobile-web-session-browser-create'
import { MOBILE_WEB_SOURCE_CONTROL_READ_METHODS } from './mobile-web-source-control-reads'
import { MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS } from './mobile-web-source-control-history'
import { MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS } from './mobile-web-source-control-compare'
import { MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS } from './mobile-web-source-control-repository'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS } from './mobile-web-source-control-review-metadata'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS } from './mobile-web-source-control-review-link'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS } from './mobile-web-source-control-review-diff'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS } from './mobile-web-source-control-review-terminal-send'
import { MOBILE_WEB_REVIEW_METHODS } from './mobile-web-review-methods'
import { MOBILE_WEB_TASK_PROJECT_TABLE_METHOD } from './mobile-web-task-project-table'
import { MOBILE_WEB_SESSION_TERMINAL_CREATION_METHODS } from './mobile-web-session-terminal-creation'
import { MOBILE_WEB_NATIVE_CHAT_FILE_METHODS } from './mobile-web-native-chat-files'
import { MOBILE_WEB_TERMINAL_ACTION_METHODS } from './mobile-web-terminal-actions'
import { MOBILE_WEB_TERMINAL_ARTIFACT_METHODS } from './mobile-web-terminal-artifact'
import { MOBILE_WEB_MARKDOWN_TAB_METHODS } from './mobile-web-markdown-tab'
import { MOBILE_WEB_AGENT_HISTORY_METHODS } from './mobile-web-agent-history'
import { MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD } from './mobile-web-native-chat-stream'
import { MOBILE_WEB_BROWSER_INPUT_METHODS } from './mobile-web-browser-input'
import { MOBILE_WEB_BROWSER_NAVIGATION_METHODS } from './mobile-web-browser-navigation'
import { MOBILE_WEB_BROWSER_STREAM_METHODS } from './mobile-web-browser-stream'
import { MOBILE_WEB_NATIVE_CHAT_METHODS } from './mobile-web-native-chat'
import type { RpcAnyMethod } from '../core'
import { STATUS_METHODS } from './status'
import { AI_VAULT_METHODS } from './ai-vault'
import { AUTOMATION_METHODS } from './automations'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'
import { TERMINAL_METHODS } from './terminal'
import { TERMINAL_ORPHAN_METHODS } from './terminal-orphan'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'
import { BROWSER_SCREENCAST_METHODS } from './browser-screencast'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'
import { BROWSER_CLIENT_FILE_CHANNEL_METHODS } from './browser-client-file-channel'
import { BROWSER_NETWORK_TUNNEL_METHODS } from './browser-network-tunnel'
import { ORCHESTRATION_METHODS } from './orchestration'
import { NOTIFICATION_METHODS } from './notifications'
import { STATS_METHODS } from './stats'
import { DIAGNOSTICS_METHODS } from './diagnostics'
import { ACCOUNT_METHODS } from './accounts'
import { PREFLIGHT_METHODS } from './preflight'
import { COMPUTER_METHODS } from './computer'
import { SESSION_TAB_METHODS } from './session-tabs'
import { NATIVE_CHAT_METHODS } from './native-chat'
import { FILE_METHODS } from './files'
import { GIT_METHODS } from './git'
import { GITHUB_METHODS } from './github'
import { GITLAB_METHODS } from './gitlab'
import { HOSTED_REVIEW_METHODS } from './hosted-review'
import { LINEAR_METHODS } from './linear'
import { LINEAR_AGENT_ACCESS_METHODS } from './linear-agent-access'
import { JIRA_METHODS } from './jira'
import { SSH_METHODS } from './ssh'
import { SPEECH_METHODS } from './speech'
import { CLIENT_UI_METHODS } from './client-ui'
import { CLIENT_EVENT_METHODS } from './client-events'
import { WORKSPACE_PORT_METHODS } from './workspace-ports'
import { PLUGIN_METHODS } from './plugins'
import { SKILL_METHODS } from './skills'
import { CLIPBOARD_METHODS } from './clipboard'
import { HOST_CAPABILITY_METHODS } from './host-capabilities'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './runtime-client-capabilities'
import { EMULATOR_METHODS } from './emulator'
import { PAIRING_METHODS } from './pairing'
import { UPDATER_METHODS } from './updater'
import { AGENT_SESSION_METHODS } from './agent-session'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { ARTIFACT_METHODS } from './artifacts'
import { MOBILE_WEB_FILE_READ_METHODS } from './mobile-web-file-reads'
import { MOBILE_WEB_FILE_WATCH_METHOD } from './mobile-web-file-watch'
import { MOBILE_WEB_FILE_OPEN_METHOD } from './mobile-web-file-open'
import { MOBILE_WEB_FILE_WRITE_METHOD } from './mobile-web-file-write'
import { MOBILE_WEB_PACKAGE_METHODS } from './mobile-web-package'
import { MOBILE_FILE_WRITE_METHODS } from './mobile-file-write-if-unchanged'
import { AGENT_HOOK_METHODS } from './agent-hooks'

// Why: a flat manifest keeps registration order explicit and provides one
// grep-point for "what methods does the RPC server expose?" — useful when
// auditing the security boundary or wiring new CLI commands.
export const ALL_RPC_METHODS: readonly RpcAnyMethod[] = [
  ...STATUS_METHODS,
  ...AGENT_HOOK_METHODS,
  ...AI_VAULT_METHODS,
  ...ARTIFACT_METHODS,
  ...AUTOMATION_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...AGENT_SESSION_METHODS,
  ...STRUCTURED_AGENT_SESSION_METHODS,
  ...TERMINAL_METHODS,
  ...TERMINAL_ORPHAN_METHODS,
  ...BROWSER_CORE_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_EXTRA_METHODS,
  ...BROWSER_CLIENT_HOST_METHODS,
  ...BROWSER_CLIENT_FILE_CHANNEL_METHODS,
  ...BROWSER_NETWORK_TUNNEL_METHODS,
  ...ORCHESTRATION_METHODS,
  ...NOTIFICATION_METHODS,
  ...STATS_METHODS,
  ...DIAGNOSTICS_METHODS,
  ...ACCOUNT_METHODS,
  ...PREFLIGHT_METHODS,
  ...COMPUTER_METHODS,
  ...SESSION_TAB_METHODS,
  ...NATIVE_CHAT_METHODS,
  ...FILE_METHODS,
  ...MOBILE_FILE_WRITE_METHODS,
  ...GIT_METHODS,
  ...GITHUB_METHODS,
  ...GITLAB_METHODS,
  ...HOSTED_REVIEW_METHODS,
  ...LINEAR_METHODS,
  ...LINEAR_AGENT_ACCESS_METHODS,
  ...JIRA_METHODS,
  ...SSH_METHODS,
  ...SPEECH_METHODS,
  ...WORKSPACE_PORT_METHODS,
  ...PLUGIN_METHODS,
  ...SKILL_METHODS,
  ...CLIPBOARD_METHODS,
  ...HOST_CAPABILITY_METHODS,
  ...RUNTIME_CLIENT_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  ...CLIENT_UI_METHODS,
  ...EMULATOR_METHODS,
  ...PAIRING_METHODS,
  ...UPDATER_METHODS,
  ...MOBILE_WEB_FILE_READ_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_READ_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS,
  ...MOBILE_WEB_REVIEW_METHODS,
  MOBILE_WEB_TASK_PROJECT_TABLE_METHOD,
  MOBILE_WEB_FILE_WATCH_METHOD,
  MOBILE_WEB_FILE_OPEN_METHOD,
  MOBILE_WEB_FILE_WRITE_METHOD,
  ...MOBILE_WEB_TERMINAL_ACTION_METHODS,
  ...MOBILE_WEB_TERMINAL_ARTIFACT_METHODS,
  ...MOBILE_WEB_MARKDOWN_TAB_METHODS,
  ...MOBILE_WEB_AGENT_HISTORY_METHODS,
  ...MOBILE_WEB_NATIVE_CHAT_METHODS,
  ...MOBILE_WEB_NATIVE_CHAT_FILE_METHODS,
  ...MOBILE_WEB_SESSION_TERMINAL_CREATION_METHODS,
  ...MOBILE_WEB_SESSION_METHODS,
  ...MOBILE_WEB_SESSION_STREAM_METHODS,
  ...MOBILE_WEB_WORKSPACE_STREAM_METHODS,
  MOBILE_WEB_SESSION_CAPABILITIES_METHOD,
  ...MOBILE_WEB_SESSION_QUICK_COMMAND_METHODS,
  MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD,
  ...MOBILE_WEB_BROWSER_INPUT_METHODS,
  ...MOBILE_WEB_BROWSER_NAVIGATION_METHODS,
  ...MOBILE_WEB_BROWSER_STREAM_METHODS,
  MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD,
  ...MOBILE_WEB_PACKAGE_METHODS
]
