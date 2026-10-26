import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Await host-API mutation intents before executing; plugin workers' own Node access bypasses this log.

export type PluginAuditEntry = {
  ts: number
  actor: `plugin:${string}`
  method: string
  /** Bounded summary only; full parameters may contain user content. */
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
    // Report this failure to the caller without poisoning later appends.
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
      const lines = recentAuditLines(text, limit)
      return lines.flatMap((line) => {
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

function recentAuditLines(text: string, limit: number): string[] {
  if (!Number.isFinite(limit) || limit < 1) {
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-limit)
  }
  const lines: string[] = []
  let end = text.length
  const count = Math.trunc(limit)
  while (end > 0 && lines.length < count) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    if (start < end) {
      lines.push(text.slice(start, end))
    }
    if (start === 0) {
      break
    }
    end = start - 1
  }
  return lines.toReversed()
}
