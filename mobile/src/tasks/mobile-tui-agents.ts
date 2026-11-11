import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { TUI_AGENT_FAVICON_DOMAINS } from '../../../src/shared/agent-launch/catalog/tui-agent-favicon-domains'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents,
  isTuiAgentEnabled,
  pickTuiAgent
} from '../../../src/shared/agent-launch/catalog/tui-agent-selection'

// Reuse the shared registry; Metro cannot load renderer ?url icons, so the phone draws favicons.

const MOBILE_TUI_AGENT_LABELS: Record<TuiAgent, string> = TUI_AGENT_DISPLAY_NAMES

// Desktop draws these agents with built-in icons; the phone has only favicons for them.
export const MOBILE_TUI_AGENT_FAVICON_DOMAINS: Partial<Record<TuiAgent, string>> = {
  ...TUI_AGENT_FAVICON_DOMAINS,
  openclaude: 'openclaude.gitlawb.com',
  copilot: 'github.com',
  bob: 'bob.ibm.com',
  opencode: 'opencode.ai',
  dsh: 'deepseek.com',
  omp: 'omp.sh',
  kilo: 'kilo.ai',
  droid: 'factory.ai'
}

/** A newer host's agent reads by its id until this build knows its name. */
export function mobileTuiAgentLabel(agent: string): string {
  return isTuiAgent(agent) ? MOBILE_TUI_AGENT_LABELS[agent] : agent
}

// Raw host settings: anything but an array keeps the desktop opt-out defaults; an explicit `[]` enables all.
function asDisabledList(disabled: unknown): Iterable<unknown> {
  return Array.isArray(disabled) ? disabled : DEFAULT_DISABLED_TUI_AGENTS
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
