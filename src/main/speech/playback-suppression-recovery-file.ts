import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type {
  PlaybackSuppressionRecoveryStore,
  PlaybackSuppressionSnapshot
} from './playback-suppression-service'

type RecoveryRecord = {
  version: 1
  createdAt: number
  snapshot: PlaybackSuppressionSnapshot
}

function parseSnapshot(value: unknown): PlaybackSuppressionSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.backend !== 'string' ||
    typeof candidate.endpointId !== 'string' ||
    typeof candidate.muted !== 'boolean'
  ) {
    return null
  }
  return {
    backend: candidate.backend,
    endpointId: candidate.endpointId,
    ...(typeof candidate.endpointTarget === 'string'
      ? { endpointTarget: candidate.endpointTarget }
      : {}),
    muted: candidate.muted
  }
}

function parseRecoveryRecord(
  value: unknown,
  now: number,
  maxAgeMs: number
): PlaybackSuppressionSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const snapshot = parseSnapshot(candidate.snapshot)
  if (
    candidate.version !== 1 ||
    typeof candidate.createdAt !== 'number' ||
    candidate.createdAt > now ||
    now - candidate.createdAt > maxAgeMs
  ) {
    return null
  }
  return snapshot
}

export class PlaybackSuppressionRecoveryFile implements PlaybackSuppressionRecoveryStore {
  private readonly now: () => number
  private readonly maxAgeMs: number

  constructor(
    private readonly path: string,
    options: { now?: () => number; maxAgeMs?: number } = {}
  ) {
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1_000
  }

  async read(): Promise<PlaybackSuppressionSnapshot | null> {
    try {
      const parsed = parseRecoveryRecord(
        JSON.parse(await readFile(this.path, 'utf8')),
        this.now(),
        this.maxAgeMs
      )
      if (parsed) {
        return parsed
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
    }
    await this.clear()
    return null
  }

  async write(snapshot: PlaybackSuppressionSnapshot): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    try {
      const record: RecoveryRecord = { version: 1, createdAt: this.now(), snapshot }
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.path)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  async clear(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
    })
  }
}
