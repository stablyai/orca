import {
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from '../agent-trust-presets'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/types'

export function markRuntimeAgentWorkspaceTrusted(agent: TuiAgent, workspacePath: string): void {
  const preset = TUI_AGENT_CONFIG[agent].preflightTrust
  if (preset === 'cursor') {
    markCursorWorkspaceTrusted(workspacePath)
  } else if (preset === 'copilot') {
    markCopilotFolderTrusted(workspacePath)
  } else if (preset === 'codex') {
    markCodexProjectTrusted(workspacePath)
  }
}
