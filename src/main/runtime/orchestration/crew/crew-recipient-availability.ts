import type { CrewHostDerivation } from './crew-host-derivation'
import type { Party } from './crew-parties'
import type { CrewReadDependencies } from './crew-party-snapshot'
import type { OrcaSessionId } from '../../../../shared/orca-session-address'

/** Current-self decisions never enter retained parties or owner facts. */
export function crewRecipientAvailability(
  host: CrewHostDerivation,
  self: Party,
  sessionPeers: OrcaSessionId[],
  deps: CrewReadDependencies
) {
  let available: ((id: NonNullable<Party['orcaSessionId']>) => boolean | undefined) | undefined
  if (sessionPeers.length && host.recipientInputs) {
    const caller = host.recipientInputs.prepare(sessionPeers, {
      address: self.address,
      terminalHandle: self.terminalHandle ?? (self.orcaSessionId ? null : self.address),
      orcaSessionId: self.orcaSessionId,
      paneKey: self.orcaSessionId
        ? null
        : (deps.callerPaneForHandle ?? deps.paneForHandle)(self.terminalHandle ?? self.address)
    })
    const sender = host.recipientInputs.senderRun(caller)
    if (sender.kind === 'ready') {
      available = host.recipientInputs.finish(sessionPeers, sender.id, {
        livePane: (handle) => deps.livePaneForHandle?.(handle) ?? null,
        process: (handle) => deps.processForHandle?.(handle) ?? null
      })
    }
  }
  return available
}
