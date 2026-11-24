import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { AtomicSnapshotWriter } from '../../persistence/atomic-snapshot-writer'

const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const recordSchema = z.object({
  accountId: z.string(),
  runningVersion: z.string(),
  version: z.string(),
  downloadedAt: timestamp,
  snoozedUntil: timestamp.optional(),
  countdownStartedAt: timestamp.optional(),
  installAttempts: z.number().int().min(0).max(2)
})

export type TeamUpdateRestartScope = { file: string; accountId: string }
export type TeamUpdateRestartRecord = z.infer<typeof recordSchema>

export function sameTeamUpdateRestartScope(
  left: TeamUpdateRestartScope | undefined,
  right: TeamUpdateRestartScope | undefined
): boolean {
  return left?.file === right?.file && left?.accountId === right?.accountId
}

export class TeamUpdateRestartRecordStore {
  private readonly writer: AtomicSnapshotWriter

  constructor(private readonly file: string) {
    this.writer = new AtomicSnapshotWriter(() => this.file, {
      fileMode: 0o600,
      skipUnchanged: true
    })
  }

  async read(): Promise<TeamUpdateRestartRecord | null> {
    try {
      const result = recordSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')))
      return result.success ? result.data : null
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        return null
      }
      throw error
    }
  }

  write(record: TeamUpdateRestartRecord): Promise<void> {
    return this.writer.write(() => JSON.stringify(record))
  }
}
