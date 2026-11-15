import { setImmediate } from 'node:timers/promises'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import type { JournalSqlReaderPool, JournalSqlForkReader } from './journal-sql-reader-pool'
import type { JournalForkPreparationInput } from './journal-fork-preparation'
import type { JournalForkStageBegin, JournalForkInstall } from './journal-fork-stages'
import type { JournalSqlOwner } from './journal-sql-owner'

/** A private handle carries the preparation, never a retained transcript. */
export class JournalSqlForkCopy {
  private installation?: JournalForkInstall
  private closing?: Promise<void>
  private constructor(
    private readonly reader: JournalSqlForkReader,
    readonly input: JournalForkPreparationInput,
    private readonly releaseSource: () => Promise<void>,
    private readonly requestSweep: () => void
  ) {}

  static async capture(
    readers: JournalSqlReaderPool,
    input: JournalForkPreparationInput,
    releaseSource: () => Promise<void>,
    requestSweep: () => void,
    signal?: AbortSignal
  ): Promise<JournalSqlForkCopy> {
    let reader: JournalSqlForkReader
    try {
      reader = await readers.prepareFork(input, signal)
    } catch (error) {
      await releaseSource()
      throw error
    }
    const copy = new JournalSqlForkCopy(reader, input, releaseSource, requestSweep)
    try {
      for (;;) {
        throwIfSignalAborted(signal)
        const step = await reader.next()
        if (step.kind !== 'progress') {
          throw new Error('fork capture emitted rows before source release')
        }
        if (step.sourceReleased) {
          return copy
        }
        await setImmediate()
      }
    } catch (error) {
      await copy.close().catch(() => undefined)
      throw error
    }
  }

  async stage(
    writer: Pick<JournalSqlOwner, 'maintain'>,
    begin: JournalForkStageBegin,
    signal?: AbortSignal
  ): Promise<JournalForkInstall> {
    if (this.installation) {
      throw new Error('fork preparation was already staged')
    }
    const result = await writer.maintain({ kind: 'fork-stage-begin', input: begin })
    if (!result || typeof result !== 'object' || !('token' in result)) {
      throw new Error('fork writer returned no stage owner')
    }
    const token = result.token
    try {
      for (;;) {
        throwIfSignalAborted(signal)
        const step = await this.reader.next()
        if (step.kind === 'complete') {
          this.installation = { token, count: step.count, lastItemId: step.lastItemId }
          await this.close()
          return this.installation
        }
        if (step.kind === 'page') {
          let consumed = 0
          let auxiliary = false
          do {
            throwIfSignalAborted(signal)
            const ack = await writer.maintain({
              kind: 'fork-stage-page',
              token,
              ordinal: step.ordinal + consumed,
              items: auxiliary ? [] : step.items.slice(consumed)
            })
            if (!ack || typeof ack !== 'object' || !('accepted' in ack)) {
              throw new Error('fork writer returned no page acknowledgement')
            }
            consumed += ack.accepted
            auxiliary = ack.auxiliary
            await setImmediate()
          } while (consumed < step.items.length || auxiliary)
        } else {
          await setImmediate()
        }
      }
    } catch (error) {
      await this.close().catch(() => undefined)
      await writer.maintain({ kind: 'fork-abort', token }).catch(() => undefined)
      this.requestSweep()
      throw error
    }
  }
  close(): Promise<void> {
    return (this.closing ??= this.reader.close().finally(this.releaseSource))
  }
}
