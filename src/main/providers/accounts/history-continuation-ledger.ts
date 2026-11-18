import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeFileDurable, durableWriteTempPath } from '../../filesystem/durable-file-write'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import type { HistoryContinuation } from '../../../shared/ai-vault/resume/history-resume-accounts'

const schema = z.array(
  z.object({
    provider: z.enum(['codex', 'claude']),
    sessionId: z.string(),
    filePath: z.string(),
    home: z.string(),
    rootSessionId: z.string(),
    parentSessionId: z.string().optional(),
    accountId: z.string().nullable().optional(),
    openedAt: z.number()
  })
)

export class HistoryContinuationLedger {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string) {}

  async list(): Promise<HistoryContinuation[]> {
    await this.queue
    return this.read()
  }

  private async read(): Promise<HistoryContinuation[]> {
    try {
      return schema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return []
      }
      throw error
    }
  }

  record(entry: HistoryContinuation): Promise<void> {
    const pending = this.queue.then(async () => {
      const rows = await this.read()
      if (
        entry.openedAt === 0 &&
        rows.some((row) => row.provider === entry.provider && row.sessionId === entry.sessionId)
      ) {
        return
      }
      const previous = rows.find(
        (row) => row.provider === entry.provider && row.sessionId === entry.sessionId
      )
      const retained = rows.filter(
        (row) => row.provider !== entry.provider || row.sessionId !== entry.sessionId
      )
      await mkdir(dirname(this.path), { recursive: true })
      await writeFileDurable(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify([...retained, { ...previous, ...entry }]),
        0o600
      )
    })
    this.queue = pending.catch(() => {})
    return pending
  }
}
