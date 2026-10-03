// The synthetic half of the readiness census: every TuiAgent under a bounded matrix of evidence.
import { vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-freshness'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  splitTranscriptIntoChunks
} from './agent-transcript-replay-test-harness'
import { closePane, feedPane, observePane } from './readiness-census-pane-probe'

export const CENSUS_AGENTS: readonly TuiAgent[] = Object.keys(TUI_AGENT_CONFIG)
  .filter(isTuiAgent)
  .toSorted()

type TitleVariant = 'native-idle' | 'working-spinner' | 'name-only' | 'synthetic-ready' | 'none'
type StatusVariant =
  | 'none'
  | 'done-fresh'
  | 'done-stale'
  | 'working-fresh'
  | 'working-stale'
  | 'blocked-fresh'
  | 'blocked-stale'
/** present: painted on the PTY's grid. untrusted: painted, but the PTY reports another grid.
 *  absent: nothing painted. dialog-last / ready-last: a workspace-trust dialog painted after,
 *  or before, the ready screen (blocked arbitration is by text position). */
type ScreenVariant = 'present' | 'untrusted' | 'absent' | 'dialog-last' | 'ready-last'
type ForegroundVariant = 'agent' | 'shell'

type SyntheticCase = {
  title: TitleVariant
  status: StatusVariant
  screen: ScreenVariant
  foreground: ForegroundVariant
}

const TITLE_VARIANTS: readonly TitleVariant[] = [
  'native-idle',
  'working-spinner',
  'name-only',
  'synthetic-ready',
  'none'
]
const STATUS_VARIANTS: readonly StatusVariant[] = [
  'none',
  'done-fresh',
  'done-stale',
  'working-fresh',
  'working-stale',
  'blocked-fresh',
  'blocked-stale'
]

/** Explicit idle markers agents paint themselves (terminal-wait-detection.ts). */
const NATIVE_IDLE_TITLES: Partial<Record<TuiAgent, string>> = {
  claude: '✳ Claude Code',
  'claude-agent-teams': '✳ Claude Code',
  openclaude: '✳ Claude Code',
  gemini: '◇ Gemini CLI',
  pi: 'π - orca',
  omp: 'π - orca',
  opencode: 'OC | orca',
  opencode2: 'OC | orca'
}

function titleFor(agent: TuiAgent, variant: TitleVariant): string | null | undefined {
  const name = TUI_AGENT_CONFIG[agent].detectCmd
  switch (variant) {
    case 'native-idle':
      return NATIVE_IDLE_TITLES[agent]
    case 'working-spinner':
      return `⠋ ${name}`
    case 'name-only':
      return name
    case 'synthetic-ready':
      return getSyntheticAgentTerminalTitle(agent, 'done') ?? undefined
    case 'none':
      return null
  }
}

type ReadyScreen = { chunks: readonly string[]; cols: number; rows: number }

// Why the recorded ready screens: the screen-ruled, Codex, Muse, Qoder and Cursor rules key on
// them. Every other agent gets a neutral composer box, which proves only that the command painted.
const READY_SCREEN_FIXTURES: Partial<
  Record<TuiAgent, { name: string; cols: number; rows: number }>
> = {
  antigravity: { name: 'antigravity-1-2-14-ready-80x24', cols: 80, rows: 24 },
  cline: { name: 'cline-3-0-66-ready-80x24', cols: 80, rows: 24 },
  'prime-agent': { name: 'prime-agent-0-9-8-ready-80x24', cols: 80, rows: 24 },
  codex: { name: 'codex-0157-plain-ready', cols: 120, rows: 40 },
  muse: { name: 'muse-empty-folder-ready', cols: 120, rows: 32 },
  qoder: { name: 'qoder-ready', cols: 100, rows: 32 },
  'qoder-cn': { name: 'qoder-cn-signin', cols: 120, rows: 40 },
  cursor: { name: 'cursor-agent-idle-after-approval', cols: 80, rows: 24 }
}

const NEUTRAL_COMPOSER = '\x1b[2J\x1b[H╭────╮\r\n│ >  │\r\n╰────╯'
const TRUST_DIALOG =
  '\r\nDo you trust the files in this folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit\r\n'

// Why strip titles and statuses: the matrix's own title and status variants must be the only ones.
// oxlint-disable-next-line no-control-regex -- OSC sequences are delimited by ESC and BEL.
const OSC_TITLE_OR_STATUS_RE = /\x1b\](?:0|1|2|9999);[^\x07\x1b]*(?:\x07|\x1b\\)/g

function readyScreen(agent: TuiAgent): ReadyScreen {
  const fixture = READY_SCREEN_FIXTURES[agent]
  if (!fixture) {
    return { chunks: [NEUTRAL_COMPOSER], cols: 80, rows: 24 }
  }
  const data = readRuntimeFixture(fixture.name).replace(OSC_TITLE_OR_STATUS_RE, '')
  return { chunks: splitTranscriptIntoChunks(data), cols: fixture.cols, rows: fixture.rows }
}

/**
 * Why this cross-product and not the full one (~18k panes): title and first-party status are the
 * ranked evidence whose lane ORDER a rule engine could get wrong, so they are fully crossed, on a
 * painted screen with the agent in the foreground. Screen trust, foreground and clock only gate
 * the lower lanes (quiet ready screen, screen-decides gate, weak title, quiet process), which run
 * only when no title or status decided, so they are fully crossed under the two titles that
 * leave those lanes open (name-only, none). A blocking dialog outranks every title, and which
 * of dialog and ready screen came last decides it, so both orders are crossed with every title.
 * The clock is crossed everywhere: each case is read both clocked and clockless.
 */
export function syntheticCases(agent: TuiAgent): SyntheticCase[] {
  const cases = new Map<string, SyntheticCase>()
  const add = (entry: SyntheticCase): void => {
    if (titleFor(agent, entry.title) !== undefined) {
      cases.set(caseLabel(entry), entry)
    }
  }
  for (const title of TITLE_VARIANTS) {
    for (const status of STATUS_VARIANTS) {
      add({ title, status, screen: 'present', foreground: 'agent' })
    }
  }
  for (const title of ['name-only', 'none'] as const) {
    for (const screen of ['present', 'untrusted', 'absent'] as const) {
      for (const foreground of ['agent', 'shell'] as const) {
        add({ title, status: 'none', screen, foreground })
      }
    }
  }
  for (const title of TITLE_VARIANTS) {
    for (const screen of ['dialog-last', 'ready-last'] as const) {
      add({ title, status: 'none', screen, foreground: 'agent' })
    }
  }
  return [...cases.values()]
}

function screenChunks(variant: ScreenVariant, screen: ReadyScreen): readonly string[] {
  switch (variant) {
    case 'absent':
      return []
    case 'dialog-last':
      return [...screen.chunks, TRUST_DIALOG]
    case 'ready-last':
      return [TRUST_DIALOG, ...screen.chunks]
    case 'present':
    case 'untrusted':
      return screen.chunks
  }
}

function caseLabel(entry: SyntheticCase): string {
  return `title=${entry.title} status=${entry.status} screen=${entry.screen} fg=${entry.foreground}`
}

const BASE_TIME_MS = Date.UTC(2026, 0, 1)

function statusOsc(agent: TuiAgent, state: string): string {
  return `\x1b]9999;${JSON.stringify({ state, agentType: agent })}\x07`
}

/** One case's observations, keyed `<case> clock=clocked|clockless`. */
export async function runSyntheticCase(
  agent: TuiAgent,
  entry: SyntheticCase
): Promise<Record<string, string>> {
  const screen = readyScreen(agent)
  const options = {
    paneTitle: 'Terminal',
    foregroundProcess: entry.foreground === 'agent' ? TUI_AGENT_CONFIG[agent].detectCmd : 'zsh',
    data: '',
    launchAgent: agent,
    size: {
      cols: entry.screen === 'untrusted' ? screen.cols + 1 : screen.cols,
      rows: screen.rows
    }
  }
  let at = BASE_TIME_MS
  vi.setSystemTime(at)
  const { runtime, handle } = await createTranscriptPane(options)
  const [state, freshness] = entry.status.split('-')
  if (freshness === 'stale') {
    await feedPane(runtime, statusOsc(agent, state), at)
    at += AGENT_STATUS_STALE_AFTER_MS + 60_000
  }
  for (const chunk of screenChunks(entry.screen, screen)) {
    await feedPane(runtime, chunk, at)
  }
  const title = titleFor(agent, entry.title)
  if (title) {
    await feedPane(runtime, `\x1b]0;${title}\x07`, at)
  }
  if (freshness === 'fresh') {
    await feedPane(runtime, statusOsc(agent, state), at)
  }
  // Why after painting: an untrusted grid is one the TUI painted for, but the PTY no longer has.
  options.size = { cols: screen.cols, rows: screen.rows }
  const { clocked, clockless } = await observePane(runtime, handle, at)
  closePane(runtime)

  const label = caseLabel(entry)
  return { [`${label} clock=clocked`]: clocked, [`${label} clock=clockless`]: clockless }
}
