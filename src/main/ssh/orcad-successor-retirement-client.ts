import { parsePtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge'
import {
  PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD,
  parsePtyOwnershipTransferSuccessorRetirementRequest,
  parsePtyOwnershipTransferSuccessorRetirementResult
} from '../../shared/pty-ownership-transfer-successor-retirement'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'

export type OrcadSuccessorRetirementSession = Readonly<{
  targetId: string
  mux: Pick<SshChannelMultiplexer, 'request' | 'isDisposed'>
  connection: object
  transportGeneration: number
  owner: SshPtyConsumerOwnerState
  resumed: boolean
}>

/** Caller retains native historical-holder exclusion; no owner admission or legacy-RPC fallback. */
export async function retireOrcadSuccessorSourceDelivery(options: {
  sourceSshTargetId: string
  request: unknown
  readSession: () => OrcadSuccessorRetirementSession | null
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const request = parsePtyOwnershipTransferSuccessorRetirementRequest(options.request)
  const targetId = options.sourceSshTargetId
  const bound = options.readSession()
  if (!bound || bound.targetId !== targetId) {
    throw new Error('orcad_successor_retirement_session_unavailable')
  }
  const { mux, connection, transportGeneration } = bound
  const send = mux.request.bind(mux)
  const owner = Object.freeze({ ...bound.owner })
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    const current = options.readSession()
    if (
      !isPtyOwnershipTransferMutationEnabled() ||
      !current ||
      !current.resumed ||
      current.targetId !== targetId ||
      current.mux !== mux ||
      mux.isDisposed() ||
      current.connection !== connection ||
      current.transportGeneration !== transportGeneration ||
      !Number.isSafeInteger(transportGeneration) ||
      transportGeneration < 0 ||
      current.owner.mode !== 'negotiated' ||
      current.owner.clientInstanceId !== owner.clientInstanceId ||
      current.owner.clientGeneration !== owner.clientGeneration ||
      current.owner.ownerLease !== owner.ownerLease ||
      current.owner.ownerGeneration !== owner.ownerGeneration ||
      owner.ownerLease !== request.ownerLease ||
      owner.ownerGeneration !== request.successorGeneration
    ) {
      throw new Error('orcad_successor_retirement_session_changed')
    }
  }
  assertCurrent()
  const capabilities = parsePtyOwnershipBridgeCapabilities(
    await send('pty.getOwnershipBridgeCapabilities', undefined, {
      signal: options.signal,
      timeoutMs: 5_000
    })
  )
  assertCurrent()
  if (capabilities?.sourceSuccessorRetirementVersion !== 1) {
    throw new Error('orcad_successor_retirement_negotiation_required')
  }
  const reply = await send(PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD, request, {
    signal: options.signal,
    timeoutMs: 10_000
  })
  assertCurrent()
  return parsePtyOwnershipTransferSuccessorRetirementResult(reply, request)
}
