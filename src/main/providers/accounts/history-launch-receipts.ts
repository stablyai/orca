import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import type { HistoryContinuation } from '../../../shared/ai-vault/resume/history-resume-accounts'

const pin = z.object({
  provider: z.enum(['codex', 'claude']),
  sessionId: z.string(),
  filePath: z.string(),
  home: z.string(),
  rootSessionId: z.string(),
  rootTranscriptKey: z.string().optional(),
  parentSessionId: z.string().optional(),
  accountId: z.string().nullable(),
  openedAt: z.number(),
  preparedAt: z.number().optional(),
  committedAt: z.number().optional(),
  confirmedAccountLabel: z.string().optional(),
  confirmedAccountIdentity: z.string().optional()
})
const schema = z.record(z.string(), z.object({ workspaceId: z.string(), entry: pin }))
const key = (token: string) => createHash('sha256').update(token).digest('hex')

export class HistoryLaunchReceipts {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string) {}

  async get(token: string) {
    await this.queue
    return (await this.read())[key(token)]
  }

  save(
    token: string,
    workspaceId: string,
    entry: HistoryContinuation,
    confirmedAccountLabel?: string,
    confirmedAccountIdentity?: string
  ): Promise<void> {
    const operation = this.queue.then(async () => {
      const now = Date.now()
      const rows = schema.parse(
        Object.fromEntries(
          Object.entries(await this.read()).filter(
            ([, row]) =>
              (row.entry.committedAt !== undefined &&
                row.entry.committedAt + 2_592_000_000 > now) ||
              (row.entry.preparedAt ?? row.entry.openedAt) + 1_800_000 > now
          )
        )
      )
      rows[key(token)] = {
        workspaceId,
        entry: pin.parse({
          ...entry,
          preparedAt: Date.now(),
          ...(confirmedAccountLabel === undefined ? {} : { confirmedAccountLabel }),
          ...(confirmedAccountIdentity === undefined ? {} : { confirmedAccountIdentity })
        })
      }
      await mkdir(dirname(this.path), { recursive: true })
      await writeFileDurable(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify(rows),
        0o600
      )
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  async setCommitTimestamp(token: string, timestamp: number): Promise<number | undefined> {
    const operation = this.queue.then(async () => {
      const rows = await this.read()
      const row = rows[key(token)]
      if (!row) {
        return undefined
      }
      if (row.entry.committedAt) {
        return row.entry.committedAt
      }
      row.entry.committedAt = timestamp
      await writeFileDurable(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify(rows),
        0o600
      )
      return timestamp
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  private async read(): Promise<z.infer<typeof schema>> {
    try {
      return schema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return {}
      }
      throw error
    }
  }
}
