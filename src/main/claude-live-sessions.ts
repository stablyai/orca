import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Authoritative sidecar for the Claude live-PTY session-id gate. Kept out of
// the main persisted-state blob so add() — which must survive a force-quit
// right after a Claude spawn — writes a tiny bounded id list (~1ms) instead of
// triggering a full-state serialize + write on the main thread.

const CLAUDE_LIVE_SESSIONS_FILE_NAME = 'claude-live-sessions.json'
const SAVE_DEBOUNCE_MS = 1_000

// Why: bounds a corrupt/bloated persisted list — the gate only needs the few Claude sessions a daemon can keep alive.
const MAX_CLAUDE_LIVE_PTY_SESSION_IDS = 200

type ClaudeLiveSessionsFile = {
  claudeLivePtySessionIds: string[]
}

export function getClaudeLiveSessionsFile(dataFile: string): string {
  return join(dirname(dataFile), CLAUDE_LIVE_SESSIONS_FILE_NAME)
}

export function normalizeClaudeLivePtySessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  // Why: scan newest-first so the cap keeps the most recent ids, matching add()'s eviction policy.
  const ids: string[] = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index]
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
      continue
    }
    if (!ids.includes(entry)) {
      ids.push(entry)
    }
    if (ids.length >= MAX_CLAUDE_LIVE_PTY_SESSION_IDS) {
      break
    }
  }
  return ids.toReversed()
}

function serializeClaudeLiveSessions(ids: string[]): string {
  return `${JSON.stringify({ claudeLivePtySessionIds: ids } satisfies ClaudeLiveSessionsFile)}\n`
}

function readClaudeLiveSessions(file: string): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ClaudeLiveSessionsFile>
    return normalizeClaudeLivePtySessionIds(parsed.claudeLivePtySessionIds)
  } catch {
    return null
  }
}

function idsEqual(left: string[], right: string[] | null): boolean {
  if (right === null || left.length !== right.length) {
    return false
  }
  return left.every((id, index) => id === right[index])
}

export class ClaudeLiveSessions {
  private readonly file: string
  private ids: string[]
  private persistedIds: string[] | null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private writeGeneration = 0

  // legacyIds: ids the main state blob used to carry, used to seed the sidecar
  // on the first launch after the split (before any sidecar file exists).
  constructor(dataFile: string, legacyIds?: unknown) {
    this.file = getClaudeLiveSessionsFile(dataFile)
    const stored = readClaudeLiveSessions(this.file)
    if (stored !== null) {
      this.ids = stored
      this.persistedIds = stored
    } else {
      this.ids = normalizeClaudeLivePtySessionIds(legacyIds)
      this.persistedIds = null
    }
  }

  get(): string[] {
    return [...this.ids]
  }

  add(sessionId: string): void {
    if (sessionId.length === 0 || sessionId.length > 512) {
      return
    }
    if (this.ids.includes(sessionId)) {
      return
    }
    // Why: drop oldest at the cap — stale ids get pruned against the daemon at startup, so only recency matters.
    this.ids = [...this.ids, sessionId].slice(-MAX_CLAUDE_LIVE_PTY_SESSION_IDS)
    // Why: write sync so a force-quit right after a Claude spawn still seeds the live-PTY gate next launch.
    this.flushOrThrow()
  }

  remove(sessionId: string): void {
    if (!this.ids.includes(sessionId)) {
      return
    }
    this.ids = this.ids.filter((id) => id !== sessionId)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    this.writeGeneration += 1
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      const generation = this.writeGeneration
      const ids = this.ids
      const previousWrite = this.pendingWrite ?? Promise.resolve()
      const nextWrite = previousWrite
        .then(() => this.writeAsync(ids, generation))
        .catch((error) => {
          console.error('[claude-live-sessions] Failed to persist sessions:', error)
        })
        .finally(() => {
          if (this.pendingWrite === nextWrite) {
            this.pendingWrite = null
          }
        })
      this.pendingWrite = nextWrite
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeAsync(ids: string[], generation: number): Promise<void> {
    const tmpFile = `${this.file}.${process.pid}.${generation}.tmp`
    let renamed = false
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmpFile, serializeClaudeLiveSessions(ids), 'utf-8')
      // Why: keep the generation guard and swap synchronous (no await between), or a concurrent
      // flushOrThrow could rename a newer list that this stale write then clobbers.
      if (generation !== this.writeGeneration) {
        return
      }
      renameSync(tmpFile, this.file)
      renamed = true
      this.persistedIds = ids
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
  }

  flushOrThrow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const asyncWriteWasInFlight = this.pendingWrite !== null
    this.writeGeneration += 1
    this.pendingWrite = null
    if (!asyncWriteWasInFlight && idsEqual(this.ids, this.persistedIds)) {
      return
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmpFile = `${this.file}.${process.pid}.${this.writeGeneration}.tmp`
    writeFileSync(tmpFile, serializeClaudeLiveSessions(this.ids), 'utf-8')
    renameSync(tmpFile, this.file)
    this.persistedIds = this.ids
  }

  async waitForPendingWrite(): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite
    }
  }
}
