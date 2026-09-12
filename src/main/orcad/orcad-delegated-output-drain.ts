import type { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'

/** Drain a bounded batch through the existing durable replay/model paths, never directly to UI. */
export async function drainOrcadDelegatedOutput(options: {
  identity: PtyOwnershipTransferWireIdentity
  adapter: PtyOwnershipTransferDestinationAdapter
  outbox: PtyOwnershipTransferDestinationOutputOutbox
  isActive: () => boolean
  prepareModelFrame?: (frame: Readonly<{ seq: number; data: string }>) => Promise<void>
}) {
  const pending = options.outbox.load(options.identity)
  if (!pending) {
    throw new Error('orcad_delegated_output_outbox_unavailable')
  }
  let drained = 0
  for (const frame of pending.pendingFrames.slice(0, 32)) {
    if (!options.isActive()) {
      break
    }
    const snapshot = options.adapter.snapshot()
    if (
      !samePtyOwnershipTransferIdentity(snapshot.identity, options.identity) ||
      snapshot.surfaceBinding?.executionHostId !== 'local'
    ) {
      throw new Error('orcad_delegated_output_destination_mismatch')
    }
    if (snapshot.phase === 'prepared') {
      // Accepted source frames prove a lower bound, not that the source has stopped producing.
      options.adapter.acceptReplay({
        ...options.identity,
        version: 1,
        phase: 'prepared',
        sourceOutputEndSeq: Math.max(snapshot.sourceOutputEndSeq, pending.acceptedEndSeq),
        replayStartSeq: frame.seq,
        frames: [frame]
      })
    } else if (snapshot.phase === 'committed' || snapshot.phase === 'published') {
      if (options.prepareModelFrame) {
        await options.prepareModelFrame(Object.freeze({ ...frame }))
        if (!options.isActive()) {
          break
        }
        const current = options.adapter.snapshot()
        if (
          !samePtyOwnershipTransferIdentity(current.identity, options.identity) ||
          current.surfaceBinding?.executionHostId !== 'local' ||
          current.phase !== snapshot.phase ||
          current.delegatedClaimActive !== snapshot.delegatedClaimActive ||
          current.delegatedClaim?.generation !== snapshot.delegatedClaim?.generation ||
          current.delegatedClaim?.claimId !== snapshot.delegatedClaim?.claimId ||
          JSON.stringify(current.surfaceBinding) !== JSON.stringify(snapshot.surfaceBinding) ||
          JSON.stringify(current.publicationReceipt) !== JSON.stringify(snapshot.publicationReceipt)
        ) {
          throw new Error('orcad_delegated_output_destination_changed')
        }
      }
      options.adapter.acceptPostCommitOutput(frame)
    } else {
      throw new Error('orcad_delegated_output_destination_unavailable')
    }
    if (!options.isActive()) {
      break
    }
    options.outbox.acknowledge(options.identity, frame.seq)
    drained++
  }
  const after = options.outbox.load(options.identity)!
  return Object.freeze({
    drained,
    acknowledgedEndSeq: after.acknowledgedEndSeq,
    hasPending: after.pendingFrames.length > 0
  })
}

/** One scheduled batch per turn; failed delivery waits for an explicit wake. */
export function createOrcadDelegatedOutputPump(
  options: Parameters<typeof drainOrcadDelegatedOutput>[0] & {
    onError: (error: unknown) => void
    onDrained?: () => void
  }
) {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let wakePending = false
  let settled = Promise.resolve()
  const active = () => !disposed && options.isActive()
  const wake = () => {
    if (!active()) {
      return
    }
    if (running) {
      wakePending = true
      return
    }
    if (timer !== undefined) {
      return
    }
    timer = setTimeout(async () => {
      timer = undefined
      if (!active()) {
        return
      }
      running = true
      let settle!: () => void
      settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      let continueDrain = false
      try {
        const result = await drainOrcadDelegatedOutput({ ...options, isActive: active })
        continueDrain = result.hasPending && result.drained > 0
        if (!result.hasPending && active()) {
          options.onDrained?.()
        }
      } catch (error) {
        if (active()) {
          try {
            options.onError(error)
          } catch {
            // Diagnostics must not strand shutdown behind a rejected timer callback.
          }
        }
      } finally {
        running = false
        settle()
        const retry = continueDrain || wakePending
        wakePending = false
        if (retry) {
          wake()
        }
      }
    }, 0)
    timer.unref?.()
  }
  return {
    wake,
    dispose: () => {
      disposed = true
      clearTimeout(timer)
      timer = undefined
      return settled
    }
  }
}
