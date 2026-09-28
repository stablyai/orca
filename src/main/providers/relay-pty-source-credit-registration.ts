import {
  installSshPtySourceAckPublisher,
  installSshPtySourceCancellationPublisher
} from '../ipc/ssh-pty-output-intake-registry'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

/** SSH and guest relays share one credit authority; only their terminal ID mapping differs. */
export function registerRelayPtySourceCredit(
  mux: SshChannelMultiplexer,
  generation: number,
  toRelayPtyId: (id: string) => string
): { releaseAck: () => void; releaseCancellation: () => void } {
  const releaseAck = installSshPtySourceAckPublisher(generation, (batch, onSettled) =>
    mux.notifyWithSettlement('pty.ackData', { ...batch }, (settlement) =>
      onSettled(
        settlement.outcome === 'accepted' ? { ok: true } : { ok: false, error: settlement.error }
      )
    )
  )
  try {
    const releaseCancellation = installSshPtySourceCancellationPublisher(
      generation,
      async (request) => {
        const result: unknown = await mux.request('pty.cancelDelivery', {
          ...request,
          id: toRelayPtyId(request.id)
        })
        if (
          !result ||
          typeof result !== 'object' ||
          !('canceled' in result) ||
          result.canceled !== true ||
          !('sentEndSu' in result) ||
          typeof result.sentEndSu !== 'number' ||
          !Number.isSafeInteger(result.sentEndSu) ||
          result.sentEndSu < 0 ||
          !('creditedEndSu' in result) ||
          typeof result.creditedEndSu !== 'number' ||
          !Number.isSafeInteger(result.creditedEndSu) ||
          result.creditedEndSu < 0 ||
          result.creditedEndSu > result.sentEndSu
        ) {
          throw new Error('ssh_source_cancellation_proof_invalid')
        }
        return { sentEndSu: result.sentEndSu, creditedEndSu: result.creditedEndSu }
      }
    )
    return { releaseAck, releaseCancellation }
  } catch (error) {
    releaseAck()
    throw error
  }
}
