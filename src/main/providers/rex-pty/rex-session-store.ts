import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RexPrivateJournal } from './rex-private-journal'
import {
  RexFreshIntentJournal,
  type RexDispatchEvidence,
  type RexFreshReservation
} from './rex-fresh-intent'
import { RexRetirementJournal } from './rex-retirement-journal'
import {
  matchesRexServer,
  rexLocalPtyId,
  rexSessionRecord,
  type RexSessionRecord
} from './rex-session-record'

export const MAX_REX_RECORDS = 128
const recordName = /^(?:rex-[0-9a-f-]{36}|[0-9a-f]{64})\.json$/
function missingRecord(): Error {
  return Object.assign(new Error('Rex identity record missing'), { code: 'ENOENT' })
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Immutable identity records, never arbitrary env values, commands or reconnect tokens. */
export class RexSessionStore {
  private readonly fresh: RexFreshIntentJournal
  readonly retirements: RexRetirementJournal
  private readonly records: RexPrivateJournal
  constructor(directory: string) {
    this.records = new RexPrivateJournal(directory)
    this.fresh = new RexFreshIntentJournal(directory)
    this.retirements = new RexRetirementJournal(directory)
  }

  private key(id: string): string {
    const valid = rexLocalPtyId.parse(id)
    const name = valid.includes('@@') ? createHash('sha256').update(valid).digest('hex') : valid
    return `${name}.json`
  }

  private async count(): Promise<number> {
    const pending = (await this.fresh.listNames()).length
    const records = (await this.records.listNames(true)).filter((name) =>
      recordName.test(name)
    ).length
    return pending + records
  }

  private freshKey(id: string): string {
    return createHash('sha256').update(rexLocalPtyId.parse(id)).digest('hex').concat('.json')
  }

  /** Count reservations before records: a launch publishes its record before dropping its intent. */
  async atCapacity(): Promise<boolean> {
    await this.records.ensureDirectory()
    return (await this.count()) >= MAX_REX_RECORDS
  }

  /** Only the reserving controller may release its intent. A lost response or
   * crash is not permission to launch a second process for the same identity. */
  async reserveFresh(id: string): Promise<RexFreshReservation> {
    const key = this.freshKey(id)
    if (await this.atCapacity()) {
      throw new Error('Rex managed session capacity reached')
    }
    const reservation = await this.fresh.reserve(key, id)
    try {
      // Recheck after exclusive publication so parallel launches cannot all claim the last slot.
      if ((await this.count()) > MAX_REX_RECORDS) {
        throw new Error('Rex managed session capacity reached')
      }
      if (await this.records.read(this.key(id), rexSessionRecord.parse)) {
        throw new Error('Rex PTY identity already persisted')
      }
    } catch (error) {
      await reservation.release()
      throw error
    }
    return reservation
  }

  private async assertFreshSettled(id: string): Promise<void> {
    const key = this.freshKey(id)
    if (await this.fresh.read(key)) {
      throw new Error(await this.fresh.describe(key))
    }
  }

  async recoverFresh(
    id: string,
    verify: (
      record: RexSessionRecord,
      dispatch: RexDispatchEvidence,
      released: boolean
    ) => Promise<boolean>
  ): Promise<boolean> {
    if (!(await this.records.directoryExists())) {
      return false
    }
    return this.fresh.recover(this.freshKey(id), async (intent, dispatch, released) => {
      if (intent.id !== id) {
        throw new Error('Rex launch intent identity mismatch')
      }
      const record = await this.records.read(this.key(id), rexSessionRecord.parse)
      // Only an absent pre-dispatch marker proves no request could have been sent.
      if (!dispatch) {
        return record === null && released === null
      }
      if (
        !record ||
        record.id !== id ||
        (released !== null && record.incarnationId !== released) ||
        !matchesRexServer(record.server, dispatch.server)
      ) {
        return false
      }
      await this.retirements.assertAvailable(record)
      return verify(record, dispatch, released !== null)
    })
  }

  async pendingFreshIds(): Promise<string[]> {
    if (!(await this.records.directoryExists())) {
      return []
    }
    const ids: string[] = []
    for (const name of await this.fresh.listNames()) {
      const intent = await this.fresh.read(name)
      if (intent) {
        if (this.freshKey(intent.id) !== name) {
          throw new Error('Rex launch intent filename mismatch')
        }
        ids.push(intent.id)
      }
    }
    return ids
  }

  async save(record: RexSessionRecord): Promise<void> {
    const validated = rexSessionRecord.parse(record)
    if (!(await this.records.publish(this.key(validated.id), validated))) {
      throw new Error('Rex PTY identity already persisted')
    }
  }

  private async readRequired(name: string): Promise<RexSessionRecord> {
    const record = await this.records.read(name, rexSessionRecord.parse)
    if (!record) {
      throw missingRecord()
    }
    return record
  }

  async read(id: string, expectedIncarnationId?: string): Promise<RexSessionRecord> {
    if (!(await this.records.directoryExists())) {
      throw missingRecord()
    }
    await this.assertFreshSettled(id)
    const record = await this.readRequired(this.key(id))
    await this.assertFreshSettled(id)
    if (
      record.id !== id ||
      (expectedIncarnationId !== undefined && record.incarnationId !== expectedIncarnationId)
    ) {
      throw new Error('Rex record incarnation mismatch')
    }
    return record
  }

  async list(scope?: {
    ptyIds?: readonly string[]
    worktreeId?: string
  }): Promise<RexSessionRecord[]> {
    if (scope?.ptyIds) {
      const result: RexSessionRecord[] = []
      for (const id of new Set(scope.ptyIds)) {
        try {
          const record = await this.read(id)
          if (!scope.worktreeId || record.worktreeId === scope.worktreeId) {
            result.push(record)
          }
        } catch (error) {
          if (!isMissing(error)) {
            throw error
          }
        }
      }
      return result
    }
    if (!(await this.records.directoryExists())) {
      return []
    }
    const entries = await this.records.listNames()
    await this.assertInventorySettled(scope?.worktreeId)
    const records = entries.filter((name) => recordName.test(name))
    if (records.length > MAX_REX_RECORDS) {
      throw new Error('Rex inventory exceeds limit')
    }
    const result: RexSessionRecord[] = []
    for (const name of records) {
      const record = await this.readRequired(name)
      if (this.key(record.id) !== name) {
        throw new Error('Rex record filename mismatch')
      }
      if (!scope?.worktreeId || record.worktreeId === scope.worktreeId) {
        result.push(record)
      }
    }
    await this.assertInventorySettled(scope?.worktreeId)
    return result
  }

  private async assertInventorySettled(worktreeId?: string): Promise<void> {
    for (const name of await this.fresh.listNames()) {
      const intent = await this.fresh.read(name)
      if (intent && (!worktreeId || intent.id.startsWith(worktreeId.concat('@@')))) {
        throw new Error('complete inventory unavailable: '.concat(await this.fresh.describe(name)))
      }
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const selected = new Set(ids)
    return JSON.stringify(
      (await this.list())
        .filter((record) => selected.has(record.id))
        .map((record) => ({ id: record.id, incarnationId: record.incarnationId }))
    )
  }

  async revive(state: string): Promise<void> {
    const records = z
      .array(z.object({ id: rexLocalPtyId, incarnationId: z.uuid() }))
      .max(128)
      .parse(JSON.parse(state))
    for (const record of records) {
      await this.read(record.id, record.incarnationId)
    }
  }

  async remove(id: string, incarnationId: string): Promise<void> {
    const name = this.key(id)
    const record = await this.records.read(name, rexSessionRecord.parse)
    if (!record) {
      return
    }
    if (record.id !== id || record.incarnationId !== incarnationId) {
      throw new Error('Rex record incarnation mismatch')
    }
    await this.records.remove(name)
  }
}
