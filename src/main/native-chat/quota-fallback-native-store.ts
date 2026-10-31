import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Reservation = z.object({
  operationId: z.string().min(1),
  claimId: z.string().min(1),
  credentialRef: z.string().min(1),
  sessionId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  errorCode: z.enum(['usage_limit_reached', 'usageLimitExceeded']),
  route: z.enum(['claude-api', 'openai-api']),
  pool: z.string().min(1),
  maxDebitUsd: z.number().finite().positive(),
  phase: z.enum(['reserved', 'dispatching', 'completed', 'unknown'])
})
const Reservations = z.record(z.string(), Reservation)
export type NativeQuotaReservation = z.infer<typeof Reservation>

/** One native runtime owns this directory; a restart retains every unresolved reservation. */
export class NativeQuotaReservationStore {
  private state: z.infer<typeof Reservations>
  private readonly file: string
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'native-reservations.json')
    try {
      this.state = Reservations.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
      this.state = {}
    }
  }
  completedOpenai(sessionId: string): boolean {
    const entry = this.state[sessionId]
    return entry?.phase === 'completed' && entry.route === 'openai-api'
  }
  read(sessionId: string): NativeQuotaReservation | null {
    const entry = this.state[sessionId]
    return entry && entry.phase !== 'completed' ? { ...entry } : null
  }
  write(entry: NativeQuotaReservation): void {
    const parsed = Reservation.parse(entry)
    const existing = this.read(entry.sessionId)
    if (existing && existing.operationId !== entry.operationId) {
      throw new Error('Continuation already reserved')
    }
    const next = { ...this.state, [entry.sessionId]: parsed }
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flush: true })
    renameSync(temporary, this.file)
    if (process.platform !== 'win32') {
      const directory = openSync(this.directory, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
    this.state = next
  }
}
