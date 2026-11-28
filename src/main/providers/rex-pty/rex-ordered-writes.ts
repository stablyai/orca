import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { rexTerm, type RexFreshSession } from './rex-fresh-session'
import { rexTerminalSize, rexWriteResult } from './rex-rpc-schema'
import { RexMemoryBudget } from './rex-memory-budget'

type WriteOwner = { id: string }
type Queue = { tail: Promise<void>; bytes: number; count: number; failed: boolean }
const globalBudget = new RexMemoryBudget(16 * 1024 * 1024, 8192)

/** One outstanding write RPC per live session. A failure cancels its queued suffix:
 * never send a later fragment of an interrupted input burst or replay uncertain bytes. */
export class RexOrderedWrites {
  private readonly queues = new WeakMap<WriteOwner, Queue>()

  submit(
    owner: WriteOwner,
    bytes: number,
    current: () => boolean,
    dispatch: () => Promise<WriteSettlement>
  ): Promise<WriteSettlement> {
    if (!current()) {
      return Promise.resolve(writeRefused('provider_unavailable'))
    }
    const queue = this.queues.get(owner) ?? {
      tail: Promise.resolve(),
      bytes: 0,
      count: 0,
      failed: false
    }
    if (queue.failed || queue.bytes + bytes > 2 * 1024 * 1024 || queue.count >= 2048) {
      // Cancel queued suffix on overflow rather than accepting a later fragment.
      queue.failed = true
      return Promise.resolve(writeRefused('transport_queue_full'))
    }
    const release = globalBudget.reserve(bytes + 128)
    if (!release) {
      queue.failed = true
      return Promise.resolve(writeRefused('transport_queue_full'))
    }
    this.queues.set(owner, queue)
    queue.bytes += bytes
    queue.count++
    const next = queue.tail
      .then(async (): Promise<WriteSettlement> => {
        if (queue.failed || !current()) {
          queue.failed = true
          return writeRefused('transport_rejected_before_handoff')
        }
        try {
          const result = await dispatch()
          queue.failed ||= result.outcome !== 'accepted'
          return result
        } catch {
          queue.failed = true
          return writeUnverifiable('provider_threw_after_handoff', true)
        }
      })
      .finally(() => {
        release()
        queue.bytes -= bytes
        queue.count--
        if (queue.count === 0 && this.queues.get(owner) === queue) {
          this.queues.delete(owner)
        }
      })
    queue.tail = next.then(() => undefined)
    return next
  }
}

export async function dispatchRexWrite(
  session: RexFreshSession,
  data: string,
  lost: () => void,
  current: () => boolean
): Promise<WriteSettlement> {
  try {
    if (session.record.adopted) {
      const size = await rexTerm(session, 'size', {}, rexTerminalSize.parse)
      if (size.owner !== session.clientId) {
        return writeRefused('provider_unavailable')
      }
    }
    if (!current()) {
      return writeRefused('transport_rejected_before_handoff')
    }
    const reply = await rexTerm(session, 'write', { data }, rexWriteResult.parse)
    if (reply.bytes_written !== Buffer.byteLength(data)) {
      lost()
      return writeUnverifiable('partial_write', true)
    }
    return WRITE_ACCEPTED
  } catch {
    lost()
    return writeUnverifiable('transport_settlement_lost', true)
  }
}
