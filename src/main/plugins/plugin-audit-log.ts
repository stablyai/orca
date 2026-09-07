import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Append-only audit trail for host-API mutations performed on a plugin's
 * behalf, with actor `plugin:<qualifiedKey>`. One JSONL file so support and
 * enterprise policy tooling can replay exactly what plugins did through the
 * gated API. (Honest scope: worker code acting through its own Node access
 * bypasses this — stated in the consent UI.) Mutation intents are awaited
 * before their handler runs so an API-mediated write cannot outrun the log.
 */

export type PluginAuditEntry = {
  ts: number
  actor: `plugin:${string}`
  method: string
  /** Bounded summary — never full params (they may contain user content). */
  summary: string
  outcome: 'attempt' | 'ok' | 'error'
}

export class PluginAuditLog {
  private readonly filePath: string
  private readonly rotatedFilePath: string
  private readonly maxBytes: number
  private writeChain: Promise<void> = Promise.resolve()
  private fileBytes: number | null = null

  constructor(pluginsDataDir: string, options: { maxBytes?: number } = {}) {
    this.filePath = join(pluginsDataDir, 'audit.log')
    this.rotatedFilePath = join(pluginsDataDir, 'audit.log.1')
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  }

  record(entry: PluginAuditEntry): Promise<void> {
    const write = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const line = `${JSON.stringify(entry)}\n`
      if (this.fileBytes === null) {
        this.fileBytes = await stat(this.filePath).then(
          (file) => file.size,
          () => 0
        )
      }
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (this.fileBytes > 0 && this.fileBytes + lineBytes > this.maxBytes) {
        await rm(this.rotatedFilePath, { force: true })
        await rename(this.filePath, this.rotatedFilePath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        })
        this.fileBytes = 0
      }
      await appendFile(this.filePath, line, 'utf8')
      this.fileBytes += lineBytes
    })
    // Keep the serialization chain usable after a failed append while still
    // exposing this write's failure to the mutation chokepoint.
    this.writeChain = write.catch(() => undefined)
    return write
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  async readRecent(limit = 200): Promise<PluginAuditEntry[]> {
    try {
      const [rotated, current] = await Promise.all(
        [this.rotatedFilePath, this.filePath].map((path) => readFile(path, 'utf8').catch(() => ''))
      )
      const text = rotated + current
      const lines = text.split('\n').filter((line) => line.length > 0)
      return lines.slice(-limit).flatMap((line) => {
        try {
          return [JSON.parse(line) as PluginAuditEntry]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }
}
