import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { RexPrivateJournal } from './rex-private-journal'
import { rexLocalPtyId, rexServerIdentity } from './rex-session-record'
import { providerOwnerPidAbsent } from '../../provider-process/provider-process-row-read'

const intentSchema = lazyZodSchema(() =>
  z.discriminatedUnion('version', [
    z.strictObject({ version: z.literal(1), id: rexLocalPtyId }),
    z.strictObject({
      version: z.literal(2),
      id: rexLocalPtyId,
      attempt: z.uuid(),
      ownerPid: z.number().int().positive()
    })
  ])
)
const dispatchSchema = lazyZodSchema(() =>
  z.strictObject({
    server: rexServerIdentity,
    label: z.string().regex(/^orca-rex-[0-9a-f-]{36}$/)
  })
)
const releaseSchema = lazyZodSchema(() => z.strictObject({ incarnationId: z.uuid() }))
export type RexFreshIntent = z.infer<typeof intentSchema>
export type RexDispatchEvidence = z.infer<typeof dispatchSchema>
export type RexFreshReservation = {
  release(): Promise<void>
  markDispatch(evidence: RexDispatchEvidence): Promise<void>
  markReleased(incarnationId: string): Promise<void>
}

/** Durable dispatch/release evidence. A missing reply is not a negative receipt. */
export class RexFreshIntentJournal {
  private readonly intents: RexPrivateJournal
  private readonly evidence: RexPrivateJournal
  private readonly locks: RexPrivateJournal
  constructor(directory: string) {
    this.intents = new RexPrivateJournal(join(directory, 'fresh'))
    this.evidence = new RexPrivateJournal(join(directory, 'fresh-evidence'))
    this.locks = new RexPrivateJournal(join(directory, 'fresh-recovery'))
  }

  read(key: string): Promise<RexFreshIntent | null> {
    return this.intents.read(key, intentSchema.parse)
  }

  listNames(): Promise<string[]> {
    return this.intents.listNames()
  }

  /** Diagnostic context is intentionally limited to non-secret identity evidence. */
  async describe(key: string): Promise<string> {
    const intent = await this.read(key)
    if (!intent) {
      return 'Rex launch reservation changed; retry the inventory read'
    }
    if (intent.version === 1) {
      return 'Rex launch outcome unknown: legacy reservation without dispatch evidence; do not delete the reservation'
    }
    const { dispatch, released } = await this.readEvidence(intent.attempt)
    if (!providerOwnerPidAbsent(intent.ownerPid)) {
      return [
        'Rex launch outcome unknown: reserving controller PID still present; wait or restart Orca normally.',
        ...(dispatch ? ['Inspect native session label', dispatch.label] : [])
      ].join(' ')
    }
    if (!dispatch) {
      return 'Rex launch outcome unknown: pre-dispatch reservation recovery pending'
    }
    return [
      'Rex launch outcome unknown:',
      released
        ? 'gate release recorded; exact live or retired process proof required.'
        : 'native create may have executed; no completed gate release recorded.',
      'Inspect native session label',
      dispatch.label,
      'on the original Rex server; do not delete the reservation or replay its create.'
    ].join(' ')
  }

  private async readEvidence(attempt: string) {
    return {
      dispatch: await this.evidence.read(
        'dispatch-'.concat(attempt, '.json'),
        dispatchSchema.parse
      ),
      released: await this.evidence.read('released-'.concat(attempt, '.json'), releaseSchema.parse)
    }
  }

  private async publishOnce(name: string, value: unknown): Promise<void> {
    if (!(await this.evidence.publish(name, value))) {
      throw new Error('Rex launch evidence already exists')
    }
  }

  async reserve(key: string, id: string): Promise<RexFreshReservation> {
    const attempt = randomUUID()
    if (!(await this.intents.publish(key, { version: 2, id, attempt, ownerPid: process.pid }))) {
      throw new Error(await this.describe(key))
    }
    let released = false
    return {
      markDispatch: (evidence) =>
        this.publishOnce('dispatch-'.concat(attempt, '.json'), dispatchSchema.parse(evidence)),
      markReleased: (incarnationId) =>
        this.publishOnce(
          'released-'.concat(attempt, '.json'),
          releaseSchema.parse({ incarnationId })
        ),
      release: async () => {
        if (!released) {
          released = true
          await this.clear(key, attempt)
        }
      }
    }
  }

  private async clear(key: string, attempt: string): Promise<void> {
    const current = await this.read(key)
    if (current?.version !== 2 || current.attempt !== attempt) {
      throw new Error('Rex launch reservation changed')
    }
    await this.intents.remove(key)
    // The intent deletion is already durable. Failure to remove diagnostic-only
    // evidence must not report a successful native launch as failed.
    await this.evidence
      .remove('dispatch-'.concat(attempt, '.json'), 'released-'.concat(attempt, '.json'))
      .catch(() => undefined)
  }

  async recover(
    key: string,
    inspect: (
      intent: RexFreshIntent,
      dispatch: RexDispatchEvidence | null,
      released: string | null
    ) => Promise<boolean>
  ): Promise<boolean> {
    const initial = await this.read(key)
    if (!initial || initial.version !== 2 || !providerOwnerPidAbsent(initial.ownerPid)) {
      return false
    }
    const lock = 'recover-'.concat(initial.attempt, '.json')
    if (!(await this.locks.publish(lock, { ownerPid: process.pid }))) {
      return false
    }
    try {
      const current = await this.read(key)
      if (
        current?.version !== 2 ||
        current.attempt !== initial.attempt ||
        !providerOwnerPidAbsent(current.ownerPid)
      ) {
        return false
      }
      const { dispatch, released } = await this.readEvidence(current.attempt)
      if (!(await inspect(current, dispatch, released?.incarnationId ?? null))) {
        return false
      }
      await this.clear(key, current.attempt)
      return true
    } finally {
      await this.locks.remove(lock)
    }
  }
}
