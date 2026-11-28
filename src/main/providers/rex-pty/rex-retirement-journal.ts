import { providerOwnerPidAbsent } from '../../provider-process/provider-process-row-read'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { RexPrivateJournal } from './rex-private-journal'
import type { RexSessionRecord } from './rex-session-record'

const retirementSchema = lazyZodSchema(() =>
  z.strictObject({
    version: z.literal(1),
    incarnationId: z.uuid(),
    ownerPid: z.number().int().positive().optional(),
    kind: z.literal('natural-exit').optional(),
    identities: z
      .array(
        z.object({
          pid: z.number().int().positive(),
          startedAt: z.string().min(1).max(128)
        })
      )
      .max(128)
  })
)
export type RexRetirement = z.infer<typeof retirementSchema>
/** Unknown close outcomes must survive app restarts, and must never authorize another launch. */
export class RexRetirementJournal {
  private readonly journal: RexPrivateJournal
  private readonly recovery: RexPrivateJournal
  constructor(directory: string) {
    this.journal = new RexPrivateJournal(join(directory, 'retirements'))
    this.recovery = new RexPrivateJournal(join(directory, 'retirement-recovery'))
  }

  private key(record: RexSessionRecord): string {
    return `retire-${record.incarnationId}.json`
  }

  async read(record: RexSessionRecord): Promise<RexRetirement | null> {
    const pending = await this.journal.read(this.key(record), retirementSchema.parse)
    if (pending && pending.incarnationId !== record.incarnationId) {
      throw new Error('Rex retirement identity mismatch')
    }
    return pending
  }

  async reserve(
    record: RexSessionRecord,
    identities: RexRetirement['identities'],
    kind?: 'natural-exit'
  ): Promise<RexRetirement> {
    const pending = retirementSchema.parse({
      version: 1,
      incarnationId: record.incarnationId,
      ownerPid: process.pid,
      identities,
      ...(kind ? { kind } : {})
    })
    if (!(await this.journal.publish(this.key(record), pending))) {
      throw new Error('Rex termination already dispatched or unknown')
    }
    return pending
  }

  /** Recover only after the original controller is proven absent. Reconciliation never dispatches a close. */
  async recover(
    record: RexSessionRecord,
    settle: (pending: RexRetirement) => Promise<boolean>
  ): Promise<boolean> {
    const pending = await this.read(record)
    if (!pending || !pending.ownerPid || !providerOwnerPidAbsent(pending.ownerPid)) {
      return false
    }
    const key = this.key(record)
    if (!(await this.recovery.publish(key, { ownerPid: process.pid }))) {
      return false
    }
    try {
      const current = await this.read(record)
      if (
        !current ||
        current.kind !== pending.kind ||
        current.ownerPid !== pending.ownerPid ||
        !providerOwnerPidAbsent(pending.ownerPid)
      ) {
        return false
      }
      return await settle(current)
    } finally {
      await this.recovery.remove(key)
    }
  }

  async assertAvailable(record: RexSessionRecord): Promise<void> {
    if (await this.read(record)) {
      throw new Error('Rex termination outcome unknown')
    }
  }

  async remove(record: RexSessionRecord): Promise<void> {
    await this.journal.remove(this.key(record))
  }
}
