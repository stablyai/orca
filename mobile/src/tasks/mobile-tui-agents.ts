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
  claude: t('m.OZJxvKQ'),
  'claude-agent-teams': t('m.cUAuG8c'),
  openclaude: t('m.4os-vWc'),
  codex: t('m.Tvbh_c4'),
  grok: t('m.58N2Zh8'),
  copilot: t('m.7u-Lga4'),
  opencode: t('m.qar2VvQ'),
  'mimo-code': t('m.imGLJZs'),
  ante: t('m.Y9bn4gA'),
  trae: t('m.STuGb5Q'),
  pi: t('m.BWhYVOA'),
  omp: t('m.GovXMeA'),
  gemini: t('m.qcMaCQk'),
  antigravity: t('m.tkhwBEU'),
  aider: t('m.FWr_S8c'),
  goose: t('m.Gqznj90'),
  amp: t('m.njg39j4'),
  kilo: t('m.FYcf7kI'),
  kiro: t('m.kej-9Lc'),
  crush: t('m.6Y3GKfY'),
  aug: t('m.ufugQXE'),
  autohand: t('m.RCPC-L0'),
  cline: t('m.Vqp3lvY'),
  codebuff: t('m.fm231VU'),
  'command-code': t('m.WeGqDrY'),
  continue: t('m.dSfrwic'),
  cursor: t('m.Vly29R0'),
  droid: t('m.uvSF6-U'),
  kimi: t('m.HG6jBAg'),
  'mistral-vibe': t('m.yUpY07s'),
  'qwen-code': t('m.X7ZF7JI'),
  rovo: t('m.tNRBWNU'),
  hermes: t('m.Lrz_Jb8'),
  devin: t('m.rZEdz3o'),
  openclaw: t('m.fpKzlOM')
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
