import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { createSessionTabsRetirementProofDelta } from './session-tabs-retirement-proof-delta'
import type { AgentSenderPublication } from '../../../../shared/agent-sender-associations'
import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../../../shared/runtime-types'

type SenderCarrier = {
  worktree: string
  removed?: true
  agentSenderAssociations?: AgentSenderPublication
}
type StreamFrame = SenderCarrier & {
  retiredTerminalSurfaces?: RuntimeMobileSessionRetiredTerminalSurface[]
}

type SessionTabsSenderDelta = <TFrame extends SenderCarrier>(frame: TFrame) => TFrame

/** Send a worktree's sender scope once per stream revision instead of on every status tick. A
 *  frame without the field changes nothing on any client, so omission needs no capability; a new
 *  or reconnected stream starts empty and sends complete scopes. */
function createSessionTabsSenderDelta(): SessionTabsSenderDelta {
  const delivered = new Map<string, string>()
  return <TFrame extends SenderCarrier>(frame: TFrame): TFrame => {
    const revision = frame.agentSenderAssociations?.revision
    if (frame.removed === true || !revision) {
      delivered.delete(frame.worktree)
      return frame
    }
    const key = `${revision.epoch}\0${revision.revision}`
    if (delivered.get(frame.worktree) !== key) {
      delivered.set(frame.worktree, key)
      return frame
    }
    const { agentSenderAssociations: _delivered, ...unchanged } = frame
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the one optional field is omitted; every other field passes through.
    return unchanged as TFrame
  }
}

/** Each session-tab stream's frame deltas: retirement proofs, then sender scopes. */
export function createSessionTabsStreamDelta(
  clientCapabilities: readonly RuntimeCapability[] | undefined
) {
  const proofs = createSessionTabsRetirementProofDelta(clientCapabilities)
  const senders = createSessionTabsSenderDelta()
  return <TFrame extends StreamFrame>(frame: TFrame): TFrame => senders(proofs(frame))
}
