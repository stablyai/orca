import { RuntimeAgentSenderAssociations } from '../runtime-agent-sender-associations'
import { fingerprintOrchestrationPeer } from '../orchestration/environment-transport'
import {
  RuntimeAgentOrchestrationProjection,
  type RuntimeAgentOrchestrationDependencies
} from '../runtime-agent-orchestration-projection'
import type { RuntimeConstructionServices } from './runtime-construction-services'

type SenderHost = Pick<
  RuntimeConstructionServices,
  'getExistingOrchestrationDb' | 'resolveOrchestrationWorkerServer'
>

export function createRuntimeAgentProjections(
  host: SenderHost,
  dependencies: RuntimeAgentOrchestrationDependencies
) {
  let historyChecked = false
  let peerKey: () => string | null = () => null
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
    principal: (environmentId) => {
      try {
        const { peerFingerprint, homePeerFingerprint } =
          host.resolveOrchestrationWorkerServer(environmentId)
        return homePeerFingerprint ? { peerFingerprint, homePeerFingerprint } : undefined
      } catch {
        return undefined
      }
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
