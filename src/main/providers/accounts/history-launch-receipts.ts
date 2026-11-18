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
  openedAt: z.number()
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

  save(token: string, workspaceId: string, entry: HistoryContinuation): Promise<void> {
    const operation = this.queue.then(async () => {
      const rows = await this.read()
      rows[key(token)] = { workspaceId, entry: pin.parse(entry) }
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
