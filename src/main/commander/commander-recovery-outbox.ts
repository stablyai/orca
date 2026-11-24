import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { durableWriteTempPath, writeFileDurableIfCurrent } from '../filesystem/durable-file-write'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { RecoveryEntry } from './commander-recovery-entry'

const entrySchema = z.object({
  pageId: z.string().regex(/^handoff-[0-9a-f-]{36}$/),
  projectId: z.string().min(1),
  title: z.string().min(1).max(240),
  body: z.string().max(16384)
})
export async function writeRecoveryJson(
  path: string,
  value: unknown,
  current: () => boolean = () => true
): Promise<boolean> {
  return writeFileDurableIfCurrent(
    durableWriteTempPath(path),
    path,
    JSON.stringify(value),
    current,
    0o600
  )
}

export class RecoveryOutbox {
  private disk: Promise<void> = Promise.resolve()
  private closed = false
  private running = false
  private dirty = false
  private retryMs = 2000
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly directory: string,
    private readonly send: (entry: RecoveryEntry) => Promise<void>,
    private readonly error: () => void
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.disk.then(operation)
    this.disk = result.then(
      () => {},
      () => {}
    )
    return result
  }

  async put(entry: RecoveryEntry): Promise<void> {
    await this.serialize(async () => {
      if (this.closed) {
        return
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const next = entrySchema.parse(entry)
      const path = join(this.directory, next.pageId)
      try {
        const raw = await readNodeFileWithinLimit(path, 131072)
        const prior = entrySchema.parse(JSON.parse(raw.buffer.toString('utf8')))
        if (prior.pageId === next.pageId && prior.projectId === next.projectId) {
          next.title = prior.title
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
      await writeRecoveryJson(path, next)
    })
    this.wake()
  }

  wake(): void {
    this.dirty = true
    if (this.closed || this.running || this.timer) {
      return
    }
    this.running = true
    void this.drain()
      .catch(this.error)
      .finally(() => {
        this.running = false
        if (this.dirty && !this.closed && !this.timer) {
          this.wake()
        }
      })
  }

  private async drain(): Promise<void> {
    this.dirty = false
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const names = await readdir(this.directory)
      let failed = false
      for (const name of names) {
        if (this.closed) {
          return
        }
        if (!/^handoff-[0-9a-f-]{36}$/.test(name)) {
          continue
        }
        const path = join(this.directory, name)
        try {
          const raw = (await readNodeFileWithinLimit(path, 131072)).buffer.toString('utf8')
          const entry = entrySchema.parse(JSON.parse(raw))
          if (entry.pageId !== name) {
            throw new Error('Unexpected recovery page.')
          }
          if (this.closed) {
            return
          }
          await this.send(entry)
          await this.serialize(async () => {
            if (
              !this.closed &&
              (await readNodeFileWithinLimit(path, 131072)).buffer.toString('utf8') === raw
            ) {
              await rm(path)
            }
          })
        } catch {
          failed = true
          this.error()
        }
      }
      if (failed) {
        this.error()
        this.retry()
      } else {
        this.retryMs = 2000
      }
    } catch {
      this.error()
      this.retry()
    }
  }

  private retry(): void {
    if (this.closed) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.wake()
    }, this.retryMs)
    this.timer.unref()
    this.retryMs = Math.min(60000, this.retryMs * 2)
  }

  async stop(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    await this.disk
  }
}
