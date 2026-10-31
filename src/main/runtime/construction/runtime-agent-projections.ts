import { RuntimeAgentSenderAssociations } from '../runtime-agent-sender-associations'
import { fingerprintOrchestrationPeer } from '../orchestration/environment-transport'
import {
  RuntimeAgentOrchestrationProjection,
  type RuntimeAgentOrchestrationDependencies
} from '../runtime-agent-orchestration-projection'
import type { RuntimeConstructionServices } from './runtime-construction-services'
import { environmentStoreWriteCount } from '../../../shared/runtime-environment-store-file'
import type { AgentSenderPrincipal } from '../runtime-agent-sender-history'
import type { AgentSenderHandleReads } from '../runtime-agent-sender-associations'

type SenderHost = Pick<
  RuntimeConstructionServices,
  'getExistingOrchestrationDb' | 'resolveOrchestrationWorkerServer'
>

export function createRuntimeAgentProjections(
  host: SenderHost,
  dependencies: RuntimeAgentOrchestrationDependencies & AgentSenderHandleReads
) {
  let historyChecked = false
  let peerKey: () => string | null = () => null
  // Pairings change only by registry writes; resolving reads several files, so not per Dispatch change.
  const principals = new Map<string, AgentSenderPrincipal | undefined>()
  let pairing = environmentStoreWriteCount()
  const senders = new RuntimeAgentSenderAssociations({
    ...dependencies,
    getDb: () => {
      const db = dependencies.getDb()
      if (db || historyChecked) {
        return db
      }
      historyChecked = true
      try {
        return host.getExistingOrchestrationDb()
      } catch (error) {
        // Display bookkeeping must not surface an open failure; orchestration's own use reports it.
        console.warn('[runtime] Sender identity history unavailable', error)
        return null
      }
    },
    peerFingerprint: () => {
      const key = peerKey()
      return key ? fingerprintOrchestrationPeer(key) : undefined
    },
    pairingGeneration: environmentStoreWriteCount,
    principal: (environmentId) => {
      if (pairing !== environmentStoreWriteCount()) {
        pairing = environmentStoreWriteCount()
        principals.clear()
      }
      if (!principals.has(environmentId)) {
        principals.set(environmentId, resolvePrincipal(host, environmentId))
      }
      return principals.get(environmentId)
    }
  })
  return {
    orchestration: new RuntimeAgentOrchestrationProjection(dependencies),
    senders,
    /** The RPC server owns the pairing key clients authenticate this host by. */
    setPeerKey: (read: () => string | null) => {
      peerKey = read
    }
  }
}

function resolvePrincipal(
  host: SenderHost,
  environmentId: string
): AgentSenderPrincipal | undefined {
  try {
    const { peerFingerprint, homePeerFingerprint } =
      host.resolveOrchestrationWorkerServer(environmentId)
    return homePeerFingerprint ? { peerFingerprint, homePeerFingerprint } : undefined
  } catch {
    return undefined
  }
}
