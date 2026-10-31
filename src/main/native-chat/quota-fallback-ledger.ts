import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { QuotaFallbackRoute } from './quota-fallback-policy'

const Entry = z.object({
  sessionId: z.string().min(1),
  route: z.enum(['antigravity-opus', 'claude-api', 'openai-api']),
  pool: z.string().min(1),
  reservedUsd: z.number().finite().nonnegative(),
  status: z.enum(['claimed', 'accepted', 'unknown', 'completed'])
})
const State = z.record(z.string(), Entry)

export type QuotaFallbackClaim = {
  operationId: string
  sessionId: string
  route: QuotaFallbackRoute
  pool: string
  maxDebitUsd: number
  remainingUsd: number
}

export class QuotaFallbackLedger {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  private transaction<T>(run: (state: z.infer<typeof State>) => T): T {
    const lock = join(this.directory, 'lock')
    mkdirSync(lock, { mode: 0o700 })
    try {
      const file = join(this.directory, 'ledger.json')
      let state: z.infer<typeof State>
      try {
        state = State.parse(JSON.parse(readFileSync(file, 'utf8')))
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error
        }
        state = {}
      }
      const result = run(state)
      const temporary = join(this.directory, 'ledger.tmp')
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flush: true })
      renameSync(temporary, file)
      if (process.platform !== 'win32') {
        const directory = openSync(this.directory, 'r')
        try {
          fsyncSync(directory)
        } finally {
          closeSync(directory)
        }
      }
      return result
    } finally {
      rmSync(lock, { recursive: true })
    }
  }

  claim(input: QuotaFallbackClaim): 'claimed' | 'duplicate' | 'sessionBusy' | 'budgetHeld' {
    if (!input.operationId || !input.sessionId || !input.pool) {
      throw new Error('Missing claim identity')
    }
    if (
      !Number.isFinite(input.maxDebitUsd) ||
      input.maxDebitUsd < 0 ||
      !Number.isFinite(input.remainingUsd) ||
      input.remainingUsd < 0 ||
      (input.route !== 'antigravity-opus' && input.maxDebitUsd === 0)
    ) {
      throw new Error('Invalid credit reservation')
    }
    const key = createHash('sha256').update(input.operationId).digest('hex')
    return this.transaction((state) => {
      if (Object.hasOwn(state, key)) {
        return 'duplicate'
      }
      if (
        Object.values(state).some(
          (entry) => entry.sessionId === input.sessionId && entry.status !== 'completed'
        )
      ) {
        return 'sessionBusy'
      }
      const reserved = Object.values(state)
        .filter((entry) => entry.pool === input.pool)
        .reduce((sum, entry) => sum + entry.reservedUsd, 0)
      if (reserved + input.maxDebitUsd > input.remainingUsd) {
        return 'budgetHeld'
      }
      state[key] = {
        sessionId: input.sessionId,
        route: input.route,
        pool: input.pool,
        reservedUsd: input.maxDebitUsd,
        status: 'claimed'
      }
      return 'claimed'
    })
  }

  settle(operationId: string, status: 'accepted' | 'unknown' | 'completed'): void {
    const key = createHash('sha256').update(operationId).digest('hex')
    this.transaction((state) => {
      const entry = state[key]
      if (!entry) {
        throw new Error('Unknown fallback operation')
      }
      if (entry.status === 'completed') {
        return
      }
      entry.status = status
    })
  }
}
