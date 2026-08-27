import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { IPtyProvider } from '../../../providers/types'

const RELAY_STATUS_TIMEOUT_MS = 5_000
export const UNPROVEN_RELAY_OWNER_REASON =
  'the answering SSH relay cannot be proven to own the persisted PTY binding'

type RelayStatus = { relayProcessId?: unknown }

export async function resolveSshRelayAbsenceVerdict(args: {
  provider: IPtyProvider
  bindingRelayProcessId?: string
}): Promise<PtyLivenessVerdict> {
  if (!args.provider.requestHostRpc || !args.bindingRelayProcessId) {
    return { status: 'unverifiable', reason: UNPROVEN_RELAY_OWNER_REASON }
  }
  try {
    const status = (await args.provider.requestHostRpc(
      'relay.status',
      {},
      {
        timeoutMs: RELAY_STATUS_TIMEOUT_MS
      }
    )) as RelayStatus
    return status?.relayProcessId === args.bindingRelayProcessId
      ? { status: 'exited' }
      : { status: 'unverifiable', reason: UNPROVEN_RELAY_OWNER_REASON }
  } catch {
    return { status: 'unverifiable', reason: UNPROVEN_RELAY_OWNER_REASON }
  }
}
