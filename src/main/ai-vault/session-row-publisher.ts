import type { AiVaultRowDelta, AiVaultRowObserver } from '../../shared/ai-vault-scan-rows'
import type { AiVaultSession } from '../../shared/ai-vault/contracts/ai-vault-types'

const ROW_BATCH_BYTES = 128 * 1024
const ROW_BATCH_INTERVAL_MS = 250

/** One in-flight frame; each physical ID retains only its latest pending change. */
export class SessionRowPublisher {
  private pending = new Map<string, AiVaultSession | null>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: Promise<void> | null = null
  private retired = false

  constructor(
    private readonly send: AiVaultRowObserver,
    private readonly project: (rows: AiVaultSession[]) => AiVaultSession[] = (rows) => rows
  ) {}

  readonly observe = (delta: AiVaultRowDelta): void => {
    if (this.retired) {
      return
    }
    this.accumulate(delta)
    if (this.pending.size) {
      this.schedule()
    }
  }

  finish(): void {
    this.retired = true
    this.pending.clear()
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }

  private accumulate(delta: AiVaultRowDelta): void {
    for (const id of delta.removed) {
      this.pending.set(id, null)
    }
    for (const row of delta.upserts) {
      this.pending.set(row.id, row)
    }
  }

  private schedule(): void {
    if (this.timer || this.flight) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, ROW_BATCH_INTERVAL_MS)
  }

  private flush(): Promise<void> {
    if (this.flight || this.retired) {
      return this.flight ?? Promise.resolve()
    }
    this.flight = Promise.resolve()
      .then(async () => {
        if (this.retired) {
          return
        }
        const batch = this.pending
        this.pending = new Map()
        const upserts: AiVaultSession[] = []
        const removed: string[] = []
        for (const [id, row] of batch) {
          if (row) {
            upserts.push(row)
          } else {
            removed.push(id)
          }
        }
        await this.deliver({ upserts: this.project(upserts), removed })
      })
      .catch(() => {
        // Preview failure never fails or delays the authoritative scan.
        this.finish()
      })
      .finally(() => {
        this.flight = null
        if (!this.retired && this.pending.size) {
          this.schedule()
        }
      })
    return this.flight
  }

  private async deliver(changes: AiVaultRowDelta): Promise<void> {
    let delta: AiVaultRowDelta = { upserts: [], removed: [] }
    let bytes = 0
    const flush = async (): Promise<void> => {
      if (!this.retired && (delta.upserts.length || delta.removed.length)) {
        await this.send(delta)
      }
      delta = { upserts: [], removed: [] }
      bytes = 0
    }
    for (const id of changes.removed) {
      if (this.retired) {
        return
      }
      const size = Buffer.byteLength(JSON.stringify(id)) + 1
      if (bytes + size > ROW_BATCH_BYTES) {
        await flush()
      }
      delta.removed.push(id)
      bytes += size
    }
    for (const row of changes.upserts) {
      if (this.retired) {
        return
      }
      const size = Buffer.byteLength(JSON.stringify(row)) + 1
      // Oversized previews still arrive in the ordinary final response.
      if (size > ROW_BATCH_BYTES) {
        continue
      }
      if (bytes + size > ROW_BATCH_BYTES) {
        await flush()
      }
      delta.upserts.push(row)
      bytes += size
    }
    await flush()
  }
}
