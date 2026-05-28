import type { TuiAgent } from '../../../src/shared/types'

// Why: mobile tests run from the mobile package only, so runtime imports of
// desktop shared modules can break Vitest transforms in CI. Keep this list
// mirrored with src/shared/tui-agent-selection.ts and assert parity in tests.
export const MOBILE_TUI_AGENT_AUTO_PICK_ORDER = [
  'claude',
  'codex',
  'grok',
  'copilot',
  'opencode',
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
  'openclaw'
] as const satisfies readonly TuiAgent[]

export const MOBILE_TUI_AGENT_LABELS: Record<TuiAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'OMP',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  aider: 'Aider',
  goose: 'Goose',
  amp: 'Amp',
  kilo: 'Kilocode',
  kiro: 'Kiro',
  crush: 'Charm',
  aug: 'Auggie',
  autohand: 'Autohand Code',
  cline: 'Cline',
  codebuff: 'Codebuff',
  'command-code': 'Command Code',
  continue: 'Continue',
  cursor: 'Cursor',
  droid: 'Droid',
  kimi: 'Kimi',
  'mistral-vibe': 'Mistral Vibe',
  'qwen-code': 'Qwen Code',
  rovo: 'Rovo Dev',
  hermes: 'Hermes',
  openclaw: 'OpenClaw'
}

export const MOBILE_TUI_AGENT_FAVICON_DOMAINS: Partial<Record<TuiAgent, string>> = {
  grok: 'x.ai',
  copilot: 'github.com',
  opencode: 'opencode.ai',
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
  openclaw: 'openclaw.ai'
}

export const MOBILE_TUI_AGENT_LAUNCH_COMMANDS: Record<TuiAgent, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  copilot: 'copilot',
  opencode: 'opencode',
  pi: 'pi',
  omp: 'omp',
  gemini: 'gemini',
  antigravity: 'agy',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro-cli',
  crush: 'crush',
  aug: 'auggie',
  autohand: 'autohand',
  cline: 'cline',
  codebuff: 'codebuff',
  'command-code': 'command-code',
  continue: 'continue',
  cursor: 'cursor-agent',
  droid: 'droid',
  kimi: 'kimi',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovo',
  hermes: 'hermes',
  openclaw: 'openclaw'
}

export function isMobileTuiAgent(value: unknown): value is TuiAgent {
  return MOBILE_TUI_AGENT_AUTO_PICK_ORDER.includes(value as TuiAgent)
}

export function pickMobileTuiAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const detectedSet = detected instanceof Set ? detected : new Set(detected)
  if (preferred && detectedSet.has(preferred)) {
    return preferred
  }
  for (const agent of MOBILE_TUI_AGENT_AUTO_PICK_ORDER) {
    if (detectedSet.has(agent)) {
      return agent
    }
  }
  return null
}
