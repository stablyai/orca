import type { CrewHostDerivation } from './crew-host-derivation'
import type { Party } from './crew-parties'
import type { CrewReadDependencies } from './crew-party-snapshot'
import type { CrewRecipientKey } from './crew-recipient-worker-facts'

export type CrewActionCandidate = { party: Party; preferred: string | undefined }

/** Current-self decisions never enter retained parties or owner facts. */
export function crewRecipientAvailability(
  host: CrewHostDerivation,
  self: Party,
  candidates: CrewActionCandidate[],
  deps: CrewReadDependencies,
  admitted: (address: string) => boolean,
  attached = false
) {
  const result = new Map<CrewActionCandidate, string>()
  if (!candidates.length) {
    return result
  }
  if (attached) {
    for (const candidate of candidates) {
      if (candidate.preferred && admitted(candidate.preferred)) {
        result.set(candidate, candidate.preferred)
      }
    }
    return result
  }
  const inputs = host.recipientInputs
  if (!inputs) {
    throw new Error('Crew recipient inputs are unavailable')
  }
  const terminal = {
    livePane: (handle: string) => deps.livePaneForHandle?.(handle) ?? null,
    process: (handle: string) => deps.processForHandle?.(handle) ?? null
  }
  const keyFor = (party: Party): CrewRecipientKey => {
    const terminalHandle =
      party.terminalHandle ?? (party.address.startsWith('term_') ? party.address : null)
    return {
      ...party,
      terminalHandle,
      paneKey: party.orcaSessionId
        ? null
        : terminalHandle
          ? terminal.livePane(terminalHandle)
          : null
    }
  }
  const keys = new Map(candidates.map((candidate) => [candidate, keyFor(candidate.party)]))
  const publicFirst = candidates.filter(
    (candidate) =>
      !candidate.preferred ||
      (!candidate.preferred.startsWith('dispatch:') && !candidate.preferred.startsWith('run:'))
  )
  const caller = inputs.prepare(
    publicFirst
      .map((candidate) => keys.get(candidate)!)
      .filter((key) => key.orcaSessionId || key.terminalHandle),
    {
      address: self.address,
      terminalHandle: self.terminalHandle ?? (self.orcaSessionId ? null : self.address),
      orcaSessionId: self.orcaSessionId,
      paneKey: self.orcaSessionId
        ? null
        : (deps.callerPaneForHandle ?? deps.paneForHandle)(self.terminalHandle ?? self.address)
    }
  )
  if (!caller) {
    throw new Error('Crew caller identity is unavailable')
  }
  const explicit = candidates.filter(
    (candidate) =>
      candidate.preferred &&
      (candidate.preferred.startsWith('dispatch:') || candidate.preferred.startsWith('run:')) &&
      admitted(candidate.preferred)
  )
  const qualify = inputs.qualification(
    caller,
    () => {
      if (!caller.terminalHandle && caller.orcaSessionId) {
        return { kind: 'session', orcaSessionId: caller.orcaSessionId }
      }
      const projection = (deps.openIdentityRead?.() ?? deps).callerProjection
      if (!projection || !caller.terminalHandle) {
        throw new Error('Crew attested caller is unavailable')
      }
      const captured = projection(caller.terminalHandle)
      return captured.kind === 'terminal' && caller.orcaSessionId
        ? { ...captured, orcaSessionId: caller.orcaSessionId }
        : captured
    },
    () => {
      if (!deps.maxDepth) {
        throw new Error('Crew depth setting is unavailable')
      }
      return deps.maxDepth()
    }
  )
  const nested = inputs.prepareExplicit(
    explicit.flatMap((candidate) => (candidate.preferred ? [candidate.preferred] : [])),
    terminal
  )
  const explicitCandidates = new Set(explicit)
  const publicCandidates: CrewActionCandidate[] = []
  for (const candidate of candidates) {
    const preferred = candidate.preferred
    if (preferred && explicitCandidates.has(candidate)) {
      if (inputs.explicit(preferred, caller, nested, qualify)) {
        result.set(candidate, preferred)
        continue
      }
      // A Run names a semantic mailbox; federation refusal is not a local-route invitation.
      if (
        preferred.startsWith('run:') ||
        inputs.explicitDispatch(preferred.slice(9))?.protocol_version != null
      ) {
        continue
      }
    }
    const key = keys.get(candidate)!
    if ((key.orcaSessionId || key.terminalHandle) && admitted(candidate.party.address)) {
      publicCandidates.push(candidate)
    }
  }
  if (publicCandidates.length) {
    const sender = inputs.senderRun(caller)
    if (sender.kind === 'unknown') {
      throw new Error('Crew caller inputs are incomplete')
    }
    if (sender.kind === 'ready') {
      const publicKeys = publicCandidates.map((candidate) => keys.get(candidate)!)
      inputs.prepare(publicKeys)
      const available = inputs.finish(publicKeys, sender.id, terminal)
      for (const candidate of publicCandidates) {
        const supported = available(keys.get(candidate)!)
        if (supported === undefined) {
          // A recorded worker with no current identity is an authoritative refusal.
          const id = candidate.party.orcaSessionId
          if (id && inputs.identityCovered(id) && !inputs.keyFor(id)) {
            continue
          }
          throw new Error('Crew recipient acquisition is incomplete')
        }
        if (supported) {
          result.set(candidate, candidate.party.address)
        }
      }
    }
  }
  return result
}
