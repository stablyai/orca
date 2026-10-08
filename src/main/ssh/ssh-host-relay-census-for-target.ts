import type { SshTarget } from '../../shared/ssh-types'
import type { CensusHostRelayTerminals } from './orcad-migration-terminal-gate'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'
import {
  beginSshHostCensus,
  currentSshOwner,
  isSshConnectionSolelyOwnedBy,
  runAttributedToSshOwner
} from './ssh-connection-attribution'
import {
  censusSshHostRelaysBeforeSession,
  hostTerminalProofFromCensus
} from './ssh-host-relay-terminals-on-connect'

/** The host census a terminal proof falls back to when no relay session can be asked. */
export function censusHostRelayTerminalsFor(target: SshTarget): CensusHostRelayTerminals {
  const census = async (): ReturnType<CensusHostRelayTerminals> => {
    const { connectionManager } = requireManagedOrcadInfrastructure()
    return hostTerminalProofFromCensus(
      await censusSshHostRelaysBeforeSession(await connectionManager.connect(target), target.id)
    )
  }
  // Inside a connect its decision owns the transport; outside one (CLI, delta move) the census does.
  return () => (currentSshOwner() ? census() : censusOutsideConnect(target, census))
}

async function censusOutsideConnect<T>(target: SshTarget, census: () => Promise<T>): Promise<T> {
  const owner = Symbol(target.id)
  const end = beginSshHostCensus(target.id)
  try {
    return await runAttributedToSshOwner(owner, census)
  } finally {
    end()
    await closeUnadoptedCensusTransport(target.id, owner)
  }
}

/** A transport this census opened that no connect or tunnel took over has no one to serve. */
async function closeUnadoptedCensusTransport(targetId: string, owner: symbol): Promise<void> {
  const { connectionManager } = requireManagedOrcadInfrastructure()
  const opened = connectionManager.getConnection(targetId)
  if (opened && isSshConnectionSolelyOwnedBy(opened, owner)) {
    await connectionManager.disconnectConnection(targetId, opened).catch((error: unknown) => {
      console.warn(`[ssh] Could not close the census transport for ${targetId}:`, error)
    })
  }
}
