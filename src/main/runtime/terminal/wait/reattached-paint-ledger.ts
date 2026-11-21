// What main saw each agent terminal paint before it quit, so a restart can trust a retained frame
// without asking a daemon that cannot repaint (WinPTY, a daemon before v60) to redraw it.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import type { TerminalCommandPaintRecord } from '../input/terminal-command-paint'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../../../filesystem/durable-file-write'

/** One terminal at quit: its process incarnation, the daemon's output count when its command's
 *  paint was attributed, and the agent then in front when a launch, title or mail recorded it. */
export type ReattachedPaintEntry = {
  incarnationId: string
  sequence: number
  agent?: string
  /** When a quit saved it; an entry for a terminal no run attached since is kept this long. */
  savedAt?: number
}

const LEDGER_VERSION = 1
/** A quit never waits on this write longer than this; a ledger missed only keeps today's hold. */
const SAVE_BUDGET_MS = 500
/** A restore never waits on the read longer than this; a ledger missed only keeps today's hold. */
const READ_BUDGET_MS = 500
/** An entry for a terminal no run attached since is kept this long. */
const UNTRACKED_ENTRY_MS = 7 * 24 * 60 * 60_000
/** A temp file this old is a writer's that stopped mid-quit; a younger one may still be mid-write. */
const STALE_TEMP_MS = 60_000

type LedgerFile = { version: number; entries: Record<string, ReattachedPaintEntry> }

function isEntry(value: unknown): value is ReattachedPaintEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'incarnationId' in value &&
    typeof value.incarnationId === 'string' &&
    'sequence' in value &&
    Number.isSafeInteger(value.sequence) &&
    (!('agent' in value) || typeof value.agent === 'string')
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

  /** What the last quits saved, read once; a quit cut off mid-write left a temp this reclaims. */
  private load(): Promise<Map<string, ReattachedPaintEntry>> {
    if (!this.loaded) {
      void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_TEMP_MS })
      this.loaded = readFile(this.path, 'utf-8').then(parseLedger, () => new Map())
    }
    return this.loaded.catch(() => new Map())
  }

  /** The entry the last quit saved for this terminal; any read failure is no entry. */
  async read(ptyId: string): Promise<ReattachedPaintEntry | null> {
    let timer: NodeJS.Timeout | undefined
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_BUDGET_MS)
    })
    const entry = this.load().then((entries) => entries.get(ptyId) ?? null)
    return Promise.race([entry, budget]).finally(() => clearTimeout(timer))
  }

  /** Saves this quit's terminals over the ledger within a small budget. Recent entries for
   *  terminals this run never attached (`tracked` lacks them) are kept for a later start. */
  save(entries: Map<string, ReattachedPaintEntry>, tracked: ReadonlySet<string>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SAVE_BUDGET_MS)
    })
    const write = this.load()
      .then((previous) => {
        const now = Date.now()
        const kept = [...previous].filter(
          ([ptyId, entry]) => !tracked.has(ptyId) && now - (entry.savedAt ?? 0) < UNTRACKED_ENTRY_MS
        )
        const saved = [...entries].map(([ptyId, entry]) => [ptyId, { ...entry, savedAt: now }])
        const file: LedgerFile = {
          version: LEDGER_VERSION,
          entries: Object.fromEntries([...kept, ...saved])
        }
        return writeFileDurable(durableWriteTempPath(this.path), this.path, JSON.stringify(file))
      })
      .catch(() => {})
    return Promise.race([write, budget]).finally(() => clearTimeout(timer))
  }
}

/** The proof the retained frame is the reattached agent's own paint: the same process, the same
 *  agent when one was recorded, and not one byte since main saw that command paint. */
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
    (entry.agent === undefined || entry.agent === current.agent)
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

/** This terminal's ledger entry at quit; `sequence` is the daemon's output count, or undefined
 *  when the host gives none. A typed agent has no recorded identity; the restart identifies it,
 *  and the unchanged count proves nothing ran since. A recorded agent must be screen-ruled. */
export function reattachedPaintEntry(
  pty: PaintLedgerPty,
  sequence: number | undefined
): ReattachedPaintEntry | null {
  const agent = pty.foregroundAgent ?? pty.launchAgent ?? pty.launchCommandAgent
  if (
    !pty.connected ||
    !pty.incarnationId ||
    sequence === undefined ||
    !pty.commandPaint?.hasAttributedPaint() ||
    (agent !== null && !(isTuiAgent(agent) && readsTrustedScreen(agent)))
  ) {
    return null
  }
  return { incarnationId: pty.incarnationId, sequence, ...(agent ? { agent } : {}) }
}

let ledger: ReattachedPaintLedger | null = null

export function reattachedPaintLedger(): ReattachedPaintLedger {
  ledger ??= new ReattachedPaintLedger(
    join(getAppEnvironment().getPath('userData'), 'terminal-reattach-paint.json')
  )
  return ledger
}
