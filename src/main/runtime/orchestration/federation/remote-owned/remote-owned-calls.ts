import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
import { environmentStoreWriteCount } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import type { RuntimeRequestGuard } from '../../../../../shared/runtime-rpc-envelope'
import { pairedOrchestrationPeers, type OrchestrationWorkerServer } from '../environment-transport'
import {
  closeRemoteRunLink,
  getRemoteRunLink,
  remoteRunLinkPinMatches,
  remoteServerPin,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'

export type RemoteOwnedRuntime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDb'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'readMachineName'
  | 'getRuntimeId'
  | 'notifyMessageArrived'
>

/**
 * Every call this Orca makes about a Run it coordinates on a paired server: as that Run's
 * coordinator, only under the pairing the link was made with, and only while the link is still in
 * one of `whileLink` when the request reaches the socket, so nothing leaves after a reset.
 */
export async function callRemoteOwnedServer(
  runtime: RemoteOwnedRuntime,
  link: RemoteRunLinkRow,
  call: {
    method: string
    params: unknown
    timeoutMs: number
    requestId?: string
    whileLink: readonly RemoteRunLinkRow['state'][]
  }
): Promise<unknown> {
  const db = runtime.getOrchestrationDb()
  const server = await runtime.resolveOrchestrationWorkerServer(link.environment_id)
  const pairingChanged = (now: OrchestrationWorkerServer): OrchestrationError =>
    new OrchestrationError(
      'server_pairing_changed',
      `The pairing with ${now.name} was re-made, so it no longer runs Run ${link.run_id}'s workers. No effects were applied.`,
      { effectsApplied: false, server: now.name }
    )
  const requireLink = (now: OrchestrationWorkerServer): void => {
    if (runtime.getOrchestrationDb() !== db) {
      throw new OrchestrationError(
        'remote_link_closed',
        'This Run was reset on this Orca. No effects were applied.',
        { effectsApplied: false }
      )
    }
    const current = getRemoteRunLink(db, link.conversation_id)
    const pin = remoteServerPin(now)
    if (current && current.state !== 'closed' && !remoteRunLinkPinMatches(current, pin)) {
      closeRemoteRunLink(
        db,
        current.conversation_id,
        `The pairing with ${now.name} was re-made.`,
        (handle, type) => runtime.notifyMessageArrived(handle, type)
      )
      throw pairingChanged(now)
    }
    if (!current || !call.whileLink.includes(current.state)) {
      const why =
        current?.state === 'closed'
          ? `The pairing with ${server.name} was re-made, so it no longer runs Run ${link.run_id}'s workers.`
          : `Run ${link.run_id} was reset on this Orca, so nothing more goes to ${server.name} for it.`
      throw new OrchestrationError('remote_link_closed', `${why} No effects were applied.`, {
        effectsApplied: false
      })
    }
    // A replacement link cannot authorize a request prepared for the original pairing.
    if (!remoteRunLinkPinMatches(link, pin) || !remoteRunLinkPinMatches(link, current)) {
      throw pairingChanged(now)
    }
  }
  const prepareGuard: RuntimeRequestGuard = async (connection) => {
    const now = await runtime.resolveOrchestrationWorkerServer(link.environment_id)
    const generation = environmentStoreWriteCount()
    const peers = pairedOrchestrationPeers(
      connection.hostPublicKeyB64,
      connection.credential.deviceToken
    )
    return () => {
      if (generation !== environmentStoreWriteCount()) {
        return false
      }
      requireLink(now)
      if (
        now.peerFingerprint !== peers.peerFingerprint ||
        (now.homePeerFingerprint ?? now.peerFingerprint) !== peers.homePeerFingerprint
      ) {
        throw pairingChanged(now)
      }
      return true
    }
  }
  requireLink(await runtime.resolveOrchestrationWorkerServer(link.environment_id))
  return runtime.callOrchestrationWorkerServer(
    link.environment_id,
    call.method,
    call.params,
    call.timeoutMs,
    {
      ...(call.requestId ? { orchestrationRequestId: call.requestId } : {}),
      orchestrationPeerRun: {
        runId: link.run_id,
        conversationId: link.conversation_id,
        label: runtime.readMachineName()
      }
    },
    {
      expectedEnvironmentPairingRevision: link.pairing_revision ?? undefined,
      prepareGuard
    }
  )
}

/** The server sees every caller here as one pairing, so the key is scoped to the caller first: two callers reusing an ID never collide there, and one caller retrying gets its first answer. */
export function remoteForwardRequestId(callerNamespace: string, requestId: string): string {
  return `fwd:${createHash('sha256').update(`${callerNamespace}\n${requestId}`).digest('hex').slice(0, 40)}`
}
