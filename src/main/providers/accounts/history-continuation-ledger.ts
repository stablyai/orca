import { HistoryLaunchReceipts } from './history-launch-receipts'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeFileDurable, durableWriteTempPath } from '../../filesystem/durable-file-write'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import type { HistoryContinuation } from '../../../shared/ai-vault/resume/history-resume-accounts'
import { historyTranscriptKey } from '../../../shared/ai-vault/resume/history-transcript-identity'

const schema = z.array(
  z.object({
    provider: z.enum(['codex', 'claude']),
    sessionId: z.string(),
    filePath: z.string(),
    home: z.string(),
    rootSessionId: z.string(),
    rootTranscriptKey: z.string().optional(),
    preparedAccountId: z.string().nullable().optional(),
    parentTranscriptKey: z.string().optional(),
    parentSessionId: z.string().optional(),
    accountId: z.string().nullable().optional(),
    openedAt: z.number()
  })
)

export class HistoryContinuationLedger {
  private queue: Promise<unknown> = Promise.resolve()
  readonly launchReceipts: HistoryLaunchReceipts
  constructor(private readonly path: string) {
    this.launchReceipts = new HistoryLaunchReceipts(`${path}.launch-pins.json`)
  }

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
        rows.some(
          (row) =>
            historyTranscriptKey(row.provider, row.filePath) ===
            historyTranscriptKey(entry.provider, entry.filePath)
        )
      ) {
        return
      }
      const previous = rows.find(
        (row) =>
          historyTranscriptKey(row.provider, row.filePath) ===
          historyTranscriptKey(entry.provider, entry.filePath)
      )
      const retained = rows.filter(
        (row) =>
          historyTranscriptKey(row.provider, row.filePath) !==
          historyTranscriptKey(entry.provider, entry.filePath)
      )
      await mkdir(dirname(this.path), { recursive: true })
      await writeFileDurable(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify([
          ...retained,
          { ...previous, ...entry, openedAt: Math.max(previous?.openedAt ?? 0, entry.openedAt) }
        ]),
        0o600
      )
    })
    this.queue = pending.catch(() => {})
    return pending
  }
}
