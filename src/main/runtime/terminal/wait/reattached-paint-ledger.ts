// What main saw each agent terminal paint before it quit, so a restart can trust a retained frame
// without asking a host that cannot repaint (Windows ConPTY, SSH, older daemons) to redraw it.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import type { TerminalCommandPaintRecord } from '../input/terminal-command-paint'
import { durableWriteTempPath, writeFileDurable } from '../../../filesystem/durable-file-write'

/** One terminal at quit: its process incarnation, the daemon's output count when its command's
 *  paint was attributed, and the agent then in front. */
export type ReattachedPaintEntry = { incarnationId: string; sequence: number; agent: string }

const LEDGER_VERSION = 1
/** A quit never waits on this write longer than this; a ledger missed only keeps today's hold. */
const SAVE_BUDGET_MS = 500

type LedgerFile = { version: number; entries: Record<string, ReattachedPaintEntry> }

function isEntry(value: unknown): value is ReattachedPaintEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'incarnationId' in value &&
    typeof value.incarnationId === 'string' &&
    'sequence' in value &&
    Number.isSafeInteger(value.sequence) &&
    'agent' in value &&
    typeof value.agent === 'string'
  )
}

function parseLedger(text: string): Map<string, ReattachedPaintEntry> {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== LEDGER_VERSION ||
    !('entries' in parsed) ||
    typeof parsed.entries !== 'object' ||
    parsed.entries === null
  ) {
    return new Map()
  }
  return new Map(
    Object.entries(parsed.entries).flatMap(([ptyId, entry]) =>
      isEntry(entry) ? [[ptyId, entry] as const] : []
    )
  )
}

export class ReattachedPaintLedger {
  private loaded: Promise<Map<string, ReattachedPaintEntry>> | null = null

  constructor(private readonly path: string) {}

  /** The entry the last quit saved for this terminal; any read failure is no entry. */
  async read(ptyId: string): Promise<ReattachedPaintEntry | null> {
    this.loaded ??= readFile(this.path, 'utf-8').then(parseLedger, () => new Map())
    return (await this.loaded.catch(() => new Map())).get(ptyId) ?? null
  }

  /** Replaces the ledger with this quit's terminals, within a small budget. */
  save(entries: Map<string, ReattachedPaintEntry>): Promise<void> {
    const file: LedgerFile = { version: LEDGER_VERSION, entries: Object.fromEntries(entries) }
    let timer: NodeJS.Timeout | undefined
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SAVE_BUDGET_MS)
    })
    const write = writeFileDurable(
      durableWriteTempPath(this.path),
      this.path,
      JSON.stringify(file)
    ).catch(() => {})
    return Promise.race([write, budget]).finally(() => clearTimeout(timer))
  }
}

/** The proof the retained frame is the reattached agent's own paint: the same process, the same
 *  agent, and not one byte since main saw that command paint. */
export function retainedFrameIsProven(
  entry: ReattachedPaintEntry | null,
  current: { incarnationId: string | null; reattachedSequence: number | undefined; agent: string }
): boolean {
  return (
    entry !== null &&
    current.incarnationId !== null &&
    entry.incarnationId === current.incarnationId &&
    current.reattachedSequence !== undefined &&
    entry.sequence === current.reattachedSequence &&
    entry.agent === current.agent
  )
}

/** What the ledger reads off a terminal's runtime record. */
export type PaintLedgerPty = TerminalCommandPaintRecord & {
  connected: boolean
  incarnationId: string | null
  foregroundAgent: TerminalAgent | null
  launchAgent: TuiAgent | null
  launchCommandAgent: TuiAgent | null
}

/** The command's own paint is attributed: it painted, it is still the command in front, and its
 *  start is known (a 133;C this run, or the reattach that hid it). Markerless panes never are. */
function hasAttributedPaint({ commandPaint: paint }: TerminalCommandPaintRecord): boolean {
  return (
    !!paint &&
    paint.hasPainted() &&
    paint.isCurrentReport(Number.POSITIVE_INFINITY) &&
    !paint.isCurrentReport(undefined)
  )
}

/** This terminal's ledger entry at quit; `sequence` is the daemon's output count, or undefined
 *  when the host gives none. Only screen-ruled agents need one. */
export function reattachedPaintEntry(
  pty: PaintLedgerPty,
  sequence: number | undefined
): ReattachedPaintEntry | null {
  const agent = pty.foregroundAgent ?? pty.launchAgent ?? pty.launchCommandAgent
  return pty.connected &&
    pty.incarnationId &&
    sequence !== undefined &&
    isTuiAgent(agent) &&
    readsTrustedScreen(agent) &&
    hasAttributedPaint(pty)
    ? { incarnationId: pty.incarnationId, sequence, agent }
    : null
}

let ledger: ReattachedPaintLedger | null = null

export function reattachedPaintLedger(): ReattachedPaintLedger {
  ledger ??= new ReattachedPaintLedger(
    join(getAppEnvironment().getPath('userData'), 'terminal-reattach-paint.json')
  )
  return ledger
}
