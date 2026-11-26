import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'
import type { ClaudeAccountRotationSwitch } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import { isRecord } from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import type { RotationUsageRecord } from './claude-rotation-policy'

export type RotationSwapKind = 'over' | 'prefer' | 'reset'

export type RotationFolderState = {
  nextCheckAt?: number
  nextPreferAt?: number
  note?: string
}

/** Holds token hashes and account-uuid prefixes only, never tokens. */
export type RotationState = {
  accounts: Record<string, RotationUsageRecord>
  tokens: Record<string, { account: string; at: number }>
  folders: Record<string, RotationFolderState>
  lastSwapAt?: number
  lastSwapKind?: RotationSwapKind
  lastSwapLive?: boolean
  lastSwitch?: ClaudeAccountRotationSwitch
  lastAlertAt?: number
  lastCheckedAt?: number
}

export type RotationJournalStep = 'begin' | 'a_written' | 'b_written'

/** One swap in flight; `a` gives up its login and receives the one from `b`. */
export type RotationJournal = {
  at: number
  a: string
  b: string
  /** Kept here so a pending swap still finishes after Orca stops listing one of the folders. */
  aFolder: RotationFolder
  bFolder: RotationFolder
  step: RotationJournalStep
  reason: string
  kind: RotationSwapKind
  fromAccount: string | null
  toAccount: string | null
  aOldRefresh: string
  bOldRefresh: string
  /** Orca's account records before the swap, as fingerprints. */
  records?: { a: string | null; b: string | null }
  meta?: string
  /** A folder held no login or a third account; the journal stays until both hold the two again. */
  needsRepair?: boolean
}

const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP_LINES = 2000

/** Rotation is macOS only, so mode 0o600 keeps the file to its owner. */
async function writeOwnerOnly(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFileDurable(durableWriteTempPath(path), path, contents, 0o600)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordOf<T>(value: unknown, guard: (entry: unknown) => entry is T): Record<string, T> {
  const out: Record<string, T> = {}
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (guard(entry)) {
        out[key] = entry
      }
    }
  }
  return out
}

function isUsageRecord(value: unknown): value is RotationUsageRecord {
  return (
    isRecord(value) &&
    typeof value.five === 'number' &&
    typeof value.week === 'number' &&
    typeof value.weekNext === 'number' &&
    typeof value.checkedAt === 'number'
  )
}

function isTokenEntry(value: unknown): value is { account: string; at: number } {
  return isRecord(value) && typeof value.account === 'string' && typeof value.at === 'number'
}

function isFolderState(value: unknown): value is RotationFolderState {
  return (
    isRecord(value) &&
    (value.nextCheckAt === undefined || typeof value.nextCheckAt === 'number') &&
    (value.nextPreferAt === undefined || typeof value.nextPreferAt === 'number') &&
    (value.note === undefined || typeof value.note === 'string')
  )
}

function isSwapKind(value: unknown): value is RotationSwapKind {
  return value === 'over' || value === 'prefer' || value === 'reset'
}

function isSwitch(value: unknown): value is ClaudeAccountRotationSwitch {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    typeof value.accountId === 'string' &&
    isSwapKind(value.kind) &&
    Array.isArray(value.limits)
  )
}

function isFolder(value: unknown, accountId: unknown): value is RotationFolder {
  return (
    isRecord(value) &&
    value.accountId === accountId &&
    typeof value.home === 'string' &&
    typeof value.service === 'string' &&
    typeof value.stateFile === 'string'
  )
}

function isJournal(value: unknown): value is RotationJournal {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    typeof value.a === 'string' &&
    typeof value.b === 'string' &&
    isFolder(value.aFolder, value.a) &&
    isFolder(value.bFolder, value.b) &&
    (value.step === 'begin' || value.step === 'a_written' || value.step === 'b_written') &&
    typeof value.aOldRefresh === 'string' &&
    typeof value.bOldRefresh === 'string'
  )
}

export class RotationStateFiles {
  readonly statePath: string
  readonly journalPath: string
  readonly logPath: string
  private logQueue: Promise<void> = Promise.resolve()

  constructor(readonly dir: string) {
    this.statePath = join(dir, 'state.json')
    this.journalPath = join(dir, 'journal.json')
    this.logPath = join(dir, 'log.jsonl')
  }

  async loadState(): Promise<RotationState> {
    const raw = await readJson(this.statePath)
    const saved = isRecord(raw) ? raw : {}
    return {
      accounts: recordOf(saved.accounts, isUsageRecord),
      tokens: recordOf(saved.tokens, isTokenEntry),
      folders: recordOf(saved.folders, isFolderState),
      lastSwapAt: numberOrUndefined(saved.lastSwapAt),
      lastSwapKind: isSwapKind(saved.lastSwapKind) ? saved.lastSwapKind : undefined,
      lastSwapLive: typeof saved.lastSwapLive === 'boolean' ? saved.lastSwapLive : undefined,
      lastSwitch: isSwitch(saved.lastSwitch) ? saved.lastSwitch : undefined,
      lastAlertAt: numberOrUndefined(saved.lastAlertAt),
      lastCheckedAt: numberOrUndefined(saved.lastCheckedAt)
    }
  }

  saveState(state: RotationState): Promise<void> {
    return writeOwnerOnly(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Null when there is no journal, or one that cannot be read; see `journalExists`. */
  async loadJournal(): Promise<RotationJournal | null> {
    const raw = await readJson(this.journalPath)
    return isJournal(raw) ? raw : null
  }

  /** True for an unreadable journal too: its backups may hold the only copy of a login. */
  async journalExists(): Promise<boolean> {
    try {
      await stat(this.journalPath)
      return true
    } catch (error) {
      return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    }
  }

  saveJournal(journal: RotationJournal): Promise<void> {
    return writeOwnerOnly(this.journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  }

  async removeJournal(): Promise<void> {
    await rm(this.journalPath, { force: true })
  }

  /** Lines are written in order without making callers wait. */
  log(event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields })
    this.logQueue = this.logQueue
      .then(() => this.appendLog(line))
      // The log is a convenience; a full disk must not stop a swap.
      .catch(() => {})
  }

  private async appendLog(line: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await appendFile(this.logPath, `${line}\n`, { mode: 0o600 })
    if ((await stat(this.logPath)).size > LOG_MAX_BYTES) {
      const lines = (await readFile(this.logPath, 'utf8')).trimEnd().split('\n')
      await writeOwnerOnly(this.logPath, `${lines.slice(-LOG_KEEP_LINES).join('\n')}\n`)
    }
  }
}
