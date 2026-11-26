import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import type { ClaudeAccountRotationSwitch } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import { isRecord } from './claude-rotation-keychain'
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
  step: RotationJournalStep
  reason: string
  kind: RotationSwapKind
  fromAccount: string | null
  toAccount: string | null
  aOldRefresh: string
  bOldRefresh: string
  meta?: string
}

const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP_LINES = 2000

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
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

function isJournal(value: unknown): value is RotationJournal {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    typeof value.a === 'string' &&
    typeof value.b === 'string' &&
    (value.step === 'begin' || value.step === 'a_written' || value.step === 'b_written') &&
    typeof value.aOldRefresh === 'string' &&
    typeof value.bOldRefresh === 'string'
  )
}

export class RotationStateFiles {
  readonly statePath: string
  readonly journalPath: string
  readonly logPath: string

  constructor(readonly dir: string) {
    this.statePath = join(dir, 'state.json')
    this.journalPath = join(dir, 'journal.json')
    this.logPath = join(dir, 'log.jsonl')
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  loadState(): RotationState {
    const raw = readJson(this.statePath)
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

  saveState(state: RotationState): void {
    this.ensureDir()
    writeFileAtomically(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  }

  loadJournal(): RotationJournal | null {
    const raw = readJson(this.journalPath)
    return isJournal(raw) ? raw : null
  }

  saveJournal(journal: RotationJournal): void {
    this.ensureDir()
    writeFileAtomically(this.journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600
    })
  }

  removeJournal(): void {
    rmSync(this.journalPath, { force: true })
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    try {
      this.ensureDir()
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields })
      appendFileSync(this.logPath, `${line}\n`, { mode: 0o600 })
      if (statSync(this.logPath).size > LOG_MAX_BYTES) {
        const lines = readFileSync(this.logPath, 'utf8').trimEnd().split('\n')
        writeFileAtomically(this.logPath, `${lines.slice(-LOG_KEEP_LINES).join('\n')}\n`, {
          mode: 0o600
        })
      }
    } catch {
      // The log is a convenience; a full disk must not stop a swap.
    }
  }
}
