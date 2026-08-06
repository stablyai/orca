import type { TuiAgent } from '../../../src/shared/types'
import { t } from '@/i18n/mobile-i18n'

// Why: mobile tests run from the mobile package only, so runtime imports of
// desktop shared modules can break Vitest transforms in CI. Keep this list
// mirrored with src/shared/tui-agent-selection.ts and assert parity in tests.
export const MOBILE_TUI_AGENT_AUTO_PICK_ORDER = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'grok',
  'copilot',
  'opencode',
  'mimo-code',
  'ante',
  'trae',
  'pi',
  'omp',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'autohand',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'devin',
  'openclaw'
] as const satisfies readonly TuiAgent[]

export const MOBILE_TUI_AGENT_LABELS: Record<TuiAgent, string> = {
  claude: t('mobileTuiAgents.claude'),
  'claude-agent-teams': t('mobileTuiAgents.claudeAgent'),
  openclaude: t('mobileTuiAgents.openClaude'),
  codex: t('mobileTuiAgents.codex'),
  grok: t('mobileTuiAgents.grok'),
  copilot: t('mobileTuiAgents.git'),
  opencode: t('mobileTuiAgents.openCode'),
  'mimo-code': t('mobileTuiAgents.mi'),
  ante: t('mobileTuiAgents.ante'),
  trae: t('mobileTuiAgents.trae'),
  pi: t('mobileTuiAgents.pi'),
  omp: t('mobileTuiAgents.omp'),
  gemini: t('mobileTuiAgents.gemini'),
  antigravity: t('mobileTuiAgents.antigravity'),
  aider: t('mobileTuiAgents.aider'),
  goose: t('mobileTuiAgents.goose'),
  amp: t('mobileTuiAgents.amp'),
  kilo: t('mobileTuiAgents.kilocode'),
  kiro: t('mobileTuiAgents.kiro'),
  crush: t('mobileTuiAgents.charm'),
  aug: t('mobileTuiAgents.auggie'),
  autohand: t('mobileTuiAgents.autohand'),
  cline: t('mobileTuiAgents.cline'),
  codebuff: t('mobileTuiAgents.codebuff'),
  'command-code': t('mobileTuiAgents.command'),
  continue: t('mobileTuiAgents.continue'),
  cursor: t('mobileTuiAgents.cursor'),
  droid: t('mobileTuiAgents.droid'),
  kimi: t('mobileTuiAgents.kimi'),
  'mistral-vibe': t('mobileTuiAgents.mistral'),
  'qwen-code': t('mobileTuiAgents.qwen'),
  rovo: t('mobileTuiAgents.rovo'),
  hermes: t('mobileTuiAgents.hermes'),
  devin: t('mobileTuiAgents.devin'),
  openclaw: t('mobileTuiAgents.openClaw')
}

export const MOBILE_TUI_AGENT_FAVICON_DOMAINS: Partial<Record<TuiAgent, string>> = {
  openclaude: 'openclaude.gitlawb.com',
  grok: 'x.ai',
  copilot: 'github.com',
  opencode: 'opencode.ai',
  'mimo-code': 'mimo.xiaomi.com',
  ante: 'antigma.ai',
  trae: 'www.trae.cn',
  omp: 'omp.sh',
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

export function isMobileTuiAgent(value: unknown): value is TuiAgent {
  return MOBILE_TUI_AGENT_AUTO_PICK_ORDER.includes(value as TuiAgent)
}

function normalizeDisabledMobileTuiAgents(value: unknown): TuiAgent[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<TuiAgent>()
  for (const item of value) {
    if (isMobileTuiAgent(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

export function isMobileTuiAgentEnabled(agent: TuiAgent, disabled?: unknown): boolean {
  return !normalizeDisabledMobileTuiAgents(disabled).includes(agent)
}

export function filterEnabledMobileTuiAgents<T extends TuiAgent>(
  agents: Iterable<T>,
  disabled?: unknown
): T[] {
  const disabledSet = new Set(normalizeDisabledMobileTuiAgents(disabled))
  return [...agents].filter((agent) => !disabledSet.has(agent))
}

export function pickMobileTuiAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>,
  disabled?: unknown
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const disabledSet = new Set(normalizeDisabledMobileTuiAgents(disabled))
  const detectedSet = detected instanceof Set ? detected : new Set(detected)
  if (preferred && detectedSet.has(preferred) && !disabledSet.has(preferred)) {
    return preferred
  }
  for (const agent of MOBILE_TUI_AGENT_AUTO_PICK_ORDER) {
    if (detectedSet.has(agent) && !disabledSet.has(agent)) {
      return agent
    }
  }
  return null
}
