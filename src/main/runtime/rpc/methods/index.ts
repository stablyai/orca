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
import { SKILL_METHODS } from './skills'
import { CLIPBOARD_METHODS } from './clipboard'
import { HOST_CAPABILITY_METHODS } from './host-capabilities'
import { EMULATOR_METHODS } from './emulator'
import { PAIRING_METHODS } from './pairing'
import { UPDATER_METHODS } from './updater'
import { AGENT_SESSION_METHODS } from './agent-session'

// Why: a flat manifest keeps registration order explicit and provides one
// grep-point for "what methods does the RPC server expose?" — useful when
// auditing the security boundary or wiring new CLI commands.
export const ALL_RPC_METHODS: readonly RpcAnyMethod[] = [
  ...STATUS_METHODS,
  ...AI_VAULT_METHODS,
  ...AUTOMATION_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...AGENT_SESSION_METHODS,
  ...TERMINAL_METHODS,
  ...TERMINAL_ORPHAN_METHODS,
  ...BROWSER_CORE_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_EXTRA_METHODS,
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
  ...SKILL_METHODS,
  ...CLIPBOARD_METHODS,
  ...HOST_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  ...CLIENT_UI_METHODS,
  ...EMULATOR_METHODS,
  ...PAIRING_METHODS,
  ...UPDATER_METHODS
]
