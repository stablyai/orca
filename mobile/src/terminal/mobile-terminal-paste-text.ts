import { wrapTerminalBracketedPasteText } from '../../../src/shared/terminal-bracketed-paste-text'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../src/shared/tui-agent-config'
import type { TerminalModes } from './terminal-webview-contract'

export function buildMobileTerminalPasteText(
  text: string,
  modes: TerminalModes | undefined,
  agent: string | null | undefined
): string {
  if (modes?.bracketedPasteMode !== true) {
    return text
  }
  // Windows Codex reads paste markers as keys; mobile lacks the pane host platform.
  if (
    modes.altScreen &&
    isTuiAgent(agent) &&
    TUI_AGENT_CONFIG[agent].windowsInputRecordPasteNewline
  ) {
    return text
  }
  return wrapTerminalBracketedPasteText(text)
}
