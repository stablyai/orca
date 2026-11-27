import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { translate, type Translate } from '../i18n/mobile-i18n'
import { tuiAgentDisplayName } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { TUI_AGENT_FAVICON_DOMAINS } from '../../../src/shared/agent-launch/catalog/tui-agent-favicon-domains'
import {
  filterEnabledTuiAgents,
  isTuiAgentEnabled
} from '../../../src/shared/agent-launch/catalog/tui-agent-selection'

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

/** A newer host's agent reads by its id until this build knows its name. */
export function mobileTuiAgentLabel(agent: string, t: Translate = translate): string {
  return tuiAgentDisplayName(agent, t) ?? agent
}

function asDisabledList(disabled: unknown): Iterable<unknown> | null {
  return Array.isArray(disabled) ? disabled : null
}

export function isMobileTuiAgentEnabled(agent: TuiAgent, disabled?: unknown): boolean {
  return isTuiAgentEnabled(agent, asDisabledList(disabled))
}

export function filterEnabledMobileTuiAgents<T extends TuiAgent>(
  agents: Iterable<T>,
  disabled?: unknown
): T[] {
  return filterEnabledTuiAgents(agents, asDisabledList(disabled))
}
