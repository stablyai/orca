import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { TUI_AGENT_FAVICON_DOMAINS } from '../../../src/shared/tui-agent-favicon-domains'
import {
  TUI_AGENT_AUTO_PICK_ORDER,
  filterEnabledTuiAgents,
  isTuiAgentEnabled,
  pickTuiAgent
} from '../../../src/shared/tui-agent-selection'

// Reuse the shared registry; Metro cannot load renderer ?url icons, so the phone draws favicons.
export const MOBILE_TUI_AGENT_AUTO_PICK_ORDER = TUI_AGENT_AUTO_PICK_ORDER
export const MOBILE_TUI_AGENT_LABELS: Record<TuiAgent, string> = TUI_AGENT_DISPLAY_NAMES

// Desktop draws these agents with built-in icons; the phone has only favicons for them.
export const MOBILE_TUI_AGENT_FAVICON_DOMAINS: Partial<Record<TuiAgent, string>> = {
  ...TUI_AGENT_FAVICON_DOMAINS,
  openclaude: 'openclaude.gitlawb.com',
  copilot: 'github.com',
  opencode: 'opencode.ai',
  dsh: 'deepseek.com',
  omp: 'omp.sh',
  kilo: 'kilo.ai',
  droid: 'factory.ai'
}

export const isMobileTuiAgent: (value: unknown) => value is TuiAgent = isTuiAgent

function asDisabledList(disabled: unknown): Iterable<unknown> | null {
  return Array.isArray(disabled) ? disabled : null
}

export function isMobileTuiAgentEnabled(agent: TuiAgent, disabled?: unknown): boolean {
  return isTuiAgentEnabled(agent, asDisabledList(disabled))
}

export function pickMobileTuiAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>,
  disabled?: unknown
): TuiAgent | null {
  return pickTuiAgent(preferred, detected, asDisabledList(disabled))
}

export function filterEnabledMobileTuiAgents<T extends TuiAgent>(
  agents: Iterable<T>,
  disabled?: unknown
): T[] {
  return filterEnabledTuiAgents(agents, asDisabledList(disabled))
}
