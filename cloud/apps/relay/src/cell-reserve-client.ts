import {
  CELL_DEMOTE_PATH,
  CELL_RESERVE_MAX_ITEMS,
  CELL_RESERVE_PATH,
  ReserveResponseSchema,
  type DemoteRequest,
  type ReserveItem
} from './cell-reserve-contract.js'
import type { ReserveAttempt } from './reserve-placement.js'

// The director's calls to cells. Bookings for one cell batch for up to 5 ms or 64 items;
// a cell that does not answer within the timeout is unverifiable, and every item in the
// batch reads `unreachable` (one of the request's three tries).
export const CELL_RESERVE_FLUSH_MS = 5
export const CELL_RESERVE_TIMEOUT_MS = 1_000

export type ReserveTarget = { cellId: string; cellUrl: string }

type Pending = { item: ReserveItem; resolve: (attempt: ReserveAttempt) => void }

export class CellReserveClient {
  private readonly batches = new Map<string, { target: ReserveTarget; dryRun: boolean; items: Pending[] }>()

  constructor(
    private readonly input: {
      directorId: string
      identityToken: () => Promise<string>
      fetch?: typeof fetch
      flushMs?: number
      timeoutMs?: number
    }
  ) {}

  reserve(target: ReserveTarget, item: ReserveItem, dryRun = false): Promise<ReserveAttempt> {
    const key = `${target.cellId}\u0000${dryRun ? 'dry' : 'book'}`
    return new Promise((resolve) => {
      let batch = this.batches.get(key)
      if (!batch) {
        batch = { target, dryRun, items: [] }
        this.batches.set(key, batch)
        const timer = setTimeout(() => this.flush(key), this.input.flushMs ?? CELL_RESERVE_FLUSH_MS)
        timer.unref?.()
      }
      batch.items.push({ item, resolve })
      if (batch.items.length >= CELL_RESERVE_MAX_ITEMS) this.flush(key)
    })
  }

  // The cell treats repeats as one; a failure is only logged, and the next poll retries.
  async demote(target: ReserveTarget, request: DemoteRequest): Promise<boolean> {
    try {
      const response = await this.post(target, CELL_DEMOTE_PATH, request)
      await response.body?.cancel().catch(() => undefined)
      return response.ok
    } catch {
      return false
    }
  }

  private flush(key: string): void {
    const batch = this.batches.get(key)
    if (!batch) return
    this.batches.delete(key)
    void this.send(batch.target, batch.dryRun, batch.items)
  }

  private async send(target: ReserveTarget, dryRun: boolean, items: Pending[]): Promise<void> {
    let results: Array<{ outcome: string; epoch?: number }> | null = null
    try {
      const response = await this.post(target, CELL_RESERVE_PATH, {
        v: 1,
        directorId: this.input.directorId,
        ...(dryRun ? { dryRun: true } : {}),
        items: items.map((pending) => pending.item)
      })
      if (response.ok) {
        const body = ReserveResponseSchema.safeParse(await response.json().catch(() => null))
        if (body.success && body.data.results.length === items.length) results = body.data.results
      } else {
        await response.body?.cancel().catch(() => undefined)
      }
    } catch {
      results = null
    }
    items.forEach((pending, index) => {
      const result = results?.[index]
      pending.resolve(
        !result
          ? { outcome: 'unreachable' }
          : result.outcome === 'seated-newer' && typeof result.epoch === 'number'
            ? { outcome: 'seated-newer', epoch: result.epoch }
            : { outcome: result.outcome }
      )
    })
  }

  private async post(target: ReserveTarget, path: string, body: unknown): Promise<Response> {
    return await (this.input.fetch ?? fetch)(new URL(path, target.cellUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.input.identityToken()}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.input.timeoutMs ?? CELL_RESERVE_TIMEOUT_MS)
    })
  }
}
