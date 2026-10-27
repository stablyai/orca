import { detectAgentStatusFromTitle, type AgentStatus } from '../../shared/agent-detection'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  getJcodeTerminalTitleActivity,
  getJcodeTerminalTitleStatus,
  isJcodeIdentityTerminalTitle
} from '../../shared/jcode-terminal-title'
import { resolvePublishedPaneAgentIdentity } from '../../shared/published-pane-agent-identity'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { terminalTitleBlocksExplicitAgentStatus } from './runtime-worktree-status-projection'

export function classifyJcodePtyTitleStatus(
  rawTitle: string,
  programActivity: AgentStatus | null | undefined,
  pty: RuntimePtyWorktreeRecord | undefined,
  readTabLaunchAgent: () => TuiAgent | undefined,
  readHookRows: ((paneKey: string) => AgentStatusIpcPayload[]) | null
): AgentStatus | null {
  const detectedStatus = detectAgentStatusFromTitle(rawTitle)
  if (
    programActivity ||
    isJcodeIdentityTerminalTitle(rawTitle) ||
    terminalTitleBlocksExplicitAgentStatus(rawTitle)
  ) {
    return programActivity ?? detectedStatus
  }
  if (detectedStatus !== null && getJcodeTerminalTitleActivity(rawTitle) === null) {
    return detectedStatus
  }
  const hookRow = selectRuntimeHookAgentRowForPane(
    pty?.paneKey ? (readHookRows?.(pty.paneKey) ?? []) : []
  )
  const owner = resolvePublishedPaneAgentIdentity({
    hookAgent: isTuiAgent(hookRow.agentType) ? hookRow.agentType : null,
    hookIsLive: hookRow.agentIsLive,
    foregroundAgent: pty?.foregroundAgent,
    launchAgent: readTabLaunchAgent() ?? pty?.launchAgent
  })
  return (
    (owner === 'jcode' ? getJcodeTerminalTitleStatus(rawTitle) : null) ??
    detectedStatus ??
    (owner === 'jcode' && (pty?.foregroundAgent === 'jcode' || hookRow.agentIsLive) ? 'idle' : null)
  )
}
