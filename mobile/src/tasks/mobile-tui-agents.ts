import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import {
  TUI_AGENT_AUTO_PICK_ORDER,
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents,
  pickTuiAgent
} from '../../../src/shared/tui-agent-selection'

// Why: one agent registry. Mobile keeps its own names for the favicon domains only, because
// desktop's live in the renderer catalog next to bundled `?url` icon imports Metro can't load.
export const MOBILE_TUI_AGENT_AUTO_PICK_ORDER = TUI_AGENT_AUTO_PICK_ORDER
export const MOBILE_TUI_AGENT_LABELS: Record<TuiAgent, string> = TUI_AGENT_DISPLAY_NAMES

export const MOBILE_TUI_AGENT_FAVICON_DOMAINS: Partial<Record<TuiAgent, string>> = {
  openclaude: 'openclaude.gitlawb.com',
  grok: 'x.ai',
  copilot: 'github.com',
  opencode: 'opencode.ai',
  'mimo-code': 'mimo.xiaomi.com',
  ante: 'antigma.ai',
  trae: 'www.trae.cn',
  omp: 'omp.sh',
  'prime-agent': 'primeintellect.ai',
  gemini: 'gemini.google.com',
  antigravity: 'antigravity.google',
  goose: 'goose-docs.ai',
  amp: 'ampcode.com',
  kilo: 'kilo.ai',
  kiro: 'kiro.dev',
  crush: 'charm.sh',
  aug: 'augmentcode.com',
  autohand: 'autohand.ai',
  cline: 'cline.bot',
  codebuff: 'codebuff.com',
  'command-code': 'commandcode.ai',
  continue: 'continue.dev',
  cursor: 'cursor.com',
  droid: 'factory.ai',
  kimi: 'moonshot.cn',
  'mistral-vibe': 'mistral.ai',
  'qwen-code': 'qwenlm.github.io',
  rovo: 'atlassian.com',
  hermes: 'nousresearch.com',
  devin: 'devin.ai',
  openclaw: 'openclaw.ai'
}

export const isMobileTuiAgent: (value: unknown) => value is TuiAgent = isTuiAgent

// Why: mobile passes raw persisted settings through; the shared helpers already discard non-arrays.
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
  const disabledSet = new Set(normalizeDisabledTuiAgents(disabled))
  return [...agents].filter((agent) => !disabledSet.has(agent))
}
