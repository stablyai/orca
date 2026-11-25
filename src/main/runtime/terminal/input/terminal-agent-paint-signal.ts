import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type {
  DraftPasteMarkerSignal,
  TuiAgentConfig
} from '../../../../shared/agent-launch/catalog/tui-agent-config-types'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { draftPasteReadySignalHasMarker } from '../../../../shared/agent-launch/startup/readiness/draft-paste-ready-scanner'

/**
 * The composer marker that says this agent's command painted, for agents whose bare-name title
 * is weak and whose composer draws a marker only the agent emits (Claude: `❯`+NBSP after
 * DECSET 2031, which no shell sends). Why not any visible byte: Orca's zsh OSC 133;C hook runs
 * first in `preexec_functions`, so a later user or framework preexec hook can print before the
 * agent process exists, and a cold-starting agent can print a banner long before its composer
 * (STA-2380). Null for agents whose name-only idle keeps any post-marker paint as corroboration.
 */
function paintSignalOf(config: TuiAgentConfig): DraftPasteMarkerSignal | null {
  const signal = config.draftPasteReadySignal
  return config.workerStartReadsComposerMarker === true &&
    signal !== undefined &&
    draftPasteReadySignalHasMarker(signal)
    ? signal
    : null
}

export function agentPaintSignal(
  agent: TuiAgent | null | undefined
): DraftPasteMarkerSignal | null {
  return agent ? paintSignalOf(TUI_AGENT_CONFIG[agent]) : null
}

/** One scanner per distinct agent-owned marker, so every PTY attributes paint the same way. */
export const AGENT_PAINT_SIGNALS: readonly DraftPasteMarkerSignal[] = [
  ...new Set(
    Object.values(TUI_AGENT_CONFIG)
      .map(paintSignalOf)
      .filter((signal): signal is DraftPasteMarkerSignal => signal !== null)
  )
]
