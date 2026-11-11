import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
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
  const server = runtime.resolveOrchestrationWorkerServer(link.environment_id)
  // Run again on the socket just before the frame leaves: a reset or re-pair while it waited stops it.
  const requireLink = (): void => {
    const current = getRemoteRunLink(db, link.conversation_id)
    const now = runtime.resolveOrchestrationWorkerServer(link.environment_id)
    if (
      current &&
      current.state !== 'closed' &&
      !remoteRunLinkPinMatches(current, remoteServerPin(now))
    ) {
      closeRemoteRunLink(db, current.conversation_id, `The pairing with ${now.name} was re-made.`)
      throw new OrchestrationError(
        'server_pairing_changed',
        `The pairing with ${now.name} was re-made, so it no longer runs Run ${link.run_id}'s workers. No effects were applied.`,
        { effectsApplied: false, server: now.name }
      )
    }
    if (!current || !call.whileLink.includes(current.state)) {
      // Only a re-made pairing closes a link; a reset leaves it owing a cancel.
      const why =
        current?.state === 'closed'
          ? `The pairing with ${server.name} was re-made, so it no longer runs Run ${link.run_id}'s workers.`
          : `Run ${link.run_id} was reset on this Orca, so nothing more goes to ${server.name} for it.`
      throw new OrchestrationError('remote_link_closed', `${why} No effects were applied.`, {
        effectsApplied: false
      })
    }
  }
  requireLink()
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
      prepareRequest: (request) => {
        requireLink()
        return { params: request.params, envelope: request.envelope }
      }
    }
  )
}

/** The server sees every caller here as one pairing, so the key is scoped to the caller first: two callers reusing an ID never collide there, and one caller retrying gets its first answer. */
export function remoteForwardRequestId(callerNamespace: string, requestId: string): string {
  return `fwd:${createHash('sha256').update(`${callerNamespace}\n${requestId}`).digest('hex').slice(0, 40)}`
}
