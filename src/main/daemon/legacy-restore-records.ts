import { readFileSync } from 'node:fs'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { LegacyRestoreRecord } from '../../shared/host-spawn-admission'
import { DEFAULT_MAX_HOST_TERMINALS } from './host-terminal-ledger'

// COMPAT(legacy-restore-intent): added 2026-10-11 (v1.4.214) for clients that predate
// `spawnIntent` (#27452). Remove after 2027-04-11, with the gate's undeclared-caller branches.

export type LegacyRestoreDetails = Omit<LegacyRestoreRecord, 'reason' | 'refusedAt'>

// Why the host terminal cap: a storm refusing every restore the host could run keeps each handle.
const MAX_RECORDS = DEFAULT_MAX_HOST_TERMINALS
const MAX_AGE_MS = 14 * 24 * 60 * 60_000
const PRIVATE_FILE_MODE = 0o600

// Why beside the run marker: per protocol version, so an old daemon beside a new one keeps its own.
export function legacyRestoreRecordsPathFor(automaticWorkMarkerPath: string): string {
  return `${automaticWorkMarkerPath.replace(/\.automatic-work-run\.json$/, '')}.legacy-restores.json`
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseRecord(value: unknown): LegacyRestoreRecord | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !('reason' in value) ||
    (value.reason !== 'pressure' && value.reason !== 'host_cap') ||
    !('refusedAt' in value) ||
    typeof value.refusedAt !== 'number'
  ) {
    return null
  }
  return {
    sessionId: value.sessionId,
    reason: value.reason,
    refusedAt: value.refusedAt,
    agent: 'agent' in value ? nullableString(value.agent) : null,
    cwd: 'cwd' in value ? nullableString(value.cwd) : null,
    worktreeId: 'worktreeId' in value ? nullableString(value.worktreeId) : null,
    command: 'command' in value ? nullableString(value.command) : null,
    identityDigest: 'identityDigest' in value ? nullableString(value.identityDigest) : null
  }
}

/** The agent session a restore resumes: its claim when the client sent one, else its command. */
function restoreKey(details: LegacyRestoreDetails): string {
  return details.identityDigest
    ? `claim:${details.identityDigest}`
    : details.command
      ? `command:${details.command}`
      : `session:${details.sessionId}`
}

/**
 * The host's own copy of every old-client restore it refused (owner decision Q9), so the user
 * can resume it later from any client. Never holds `env`, which can carry credentials.
 * Fail-open: a file that cannot be read or written never turns into a failed spawn.
 */
export class LegacyRestoreRecords {
  private records: LegacyRestoreRecord[] | null = null

  constructor(
    private readonly path: string | undefined,
    private readonly logger: { log: (event: string, details: Record<string, unknown>) => void },
    private readonly now: () => number = Date.now
  ) {}

  list(): readonly LegacyRestoreRecord[] {
    return this.load()
  }

  record(details: LegacyRestoreDetails, reason: LegacyRestoreRecord['reason']): void {
    const key = restoreKey(details)
    const kept = this.load().filter((record) => restoreKey(record) !== key)
    this.records = [{ ...details, reason, refusedAt: this.now() }, ...kept].slice(0, MAX_RECORDS)
    this.logger.log('legacy-restore-recorded', { reason, agent: details.agent })
    this.save()
  }

  /** A restore of the same agent session started, from this client or any other. */
  clearStarted(details: LegacyRestoreDetails): void {
    const records = this.load()
    const kept = records.filter(
      (record) =>
        !(details.identityDigest && record.identityDigest === details.identityDigest) &&
        !(details.command && record.command === details.command)
    )
    if (kept.length !== records.length) {
      this.records = kept
      this.save()
    }
  }

  private load(): LegacyRestoreRecord[] {
    if (this.records) {
      return this.records
    }
    let parsed: unknown = null
    try {
      parsed = this.path ? JSON.parse(readFileSync(this.path, 'utf8')) : null
    } catch {
      parsed = null
    }
    const raw =
      typeof parsed === 'object' && parsed !== null && 'records' in parsed ? parsed.records : null
    const now = this.now()
    this.records = (Array.isArray(raw) ? raw : [])
      .map(parseRecord)
      .filter((record): record is LegacyRestoreRecord => record !== null)
      .filter((record) => now - record.refusedAt <= MAX_AGE_MS)
      .slice(0, MAX_RECORDS)
    return this.records
  }

  private save(): void {
    if (!this.path) {
      return
    }
    try {
      writeFileDurableSync(
        durableWriteTempPath(this.path),
        this.path,
        `${JSON.stringify({ schemaVersion: 1, records: this.records ?? [] })}\n`,
        PRIVATE_FILE_MODE
      )
    } catch (error) {
      this.logger.log('legacy-restore-record-write-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
