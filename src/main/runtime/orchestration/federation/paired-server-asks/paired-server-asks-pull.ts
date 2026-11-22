// This computer takes asks from agents on a server it is paired to only when that server can send
// them: each pull loop reads the server's status once, then names itself on every pull of a session.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { PeerMailClientAsksPull } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { getPublishedHostDescriptor } from '../../../hosts/platform-probe/host-descriptor'
import { peerMailPairing } from '../peer-mail/peer-mail-delivery'
import {
  getAnnouncedPairing,
  recordAnnouncedPairing,
  rerouteServer
} from '../../db/federation/paired-server-asks-store'

const STATUS_TIMEOUT_MS = 15_000

const ServerStatus = z.object({
  capabilities: z.array(z.string()).optional(),
  hostDescriptor: z.looseObject({ installationId: z.string() }).nullish()
})

export type PairedServerAsks = {
  environmentId: string
  serverName: string
  serverInstallationId: string
  /** The credential this computer is paired to the server with now. */
  pairing: string
  wire: z.infer<typeof PeerMailClientAsksPull>
}

type Runtime = Pick<
  OrcaRuntimeService,
  | 'getRuntimeId'
  | 'readMachineName'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
>

/** What a pull loop names itself with on this server; null when the server can't send asks, or this
 *  computer or the server has no installation id yet (unverified), so the loop pulls as before. */
export async function pairedServerAsksFor(
  runtime: Runtime,
  db: OrchestrationDb,
  environmentId: string
): Promise<PairedServerAsks | null> {
  const installationId = getPublishedHostDescriptor(runtime.getRuntimeId())?.installationId
  if (!installationId) {
    return null
  }
  const server = await runtime.resolveOrchestrationWorkerServer(environmentId)
  const status = ServerStatus.safeParse(
    await runtime.callOrchestrationWorkerServer(
      environmentId,
      'status.get',
      undefined,
      STATUS_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
  )
  const serverInstallationId = status.success ? status.data.hostDescriptor?.installationId : null
  if (
    !serverInstallationId ||
    !status.data?.capabilities?.includes(ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY)
  ) {
    return null
  }
  const pairing = peerMailPairing(server)
  const announced = getAnnouncedPairing(db, serverInstallationId)
  // Named once a later pairing replaced it, so the server ends only that pairing's mail.
  const previousPairing =
    announced && announced.pairingFingerprint !== pairing
      ? announced.serverSeenFingerprint
      : undefined
  return {
    environmentId,
    serverName: server.name,
    serverInstallationId,
    pairing,
    wire: {
      session: randomUUID(),
      installationId,
      name: runtime.readMachineName(),
      ...(previousPairing ? { previousPairing } : {})
    }
  }
}

/** Whether this pairing has yet to be announced, so its loop pulls once with nothing else to do. */
export function owesAnnouncement(db: OrchestrationDb, asks: PairedServerAsks): boolean {
  return getAnnouncedPairing(db, asks.serverInstallationId)?.pairingFingerprint !== asks.pairing
}

/** The server answered under this pairing: it is announced, and the one it replaced is ended. */
export function noteAnnounced(db: OrchestrationDb, asks: PairedServerAsks, seenAs: string): void {
  recordAnnouncedPairing(db, asks.serverInstallationId, {
    environmentId: asks.environmentId,
    pairingFingerprint: asks.pairing,
    serverSeenFingerprint: seenAs
  })
  delete asks.wire.previousPairing
}

/** The same server answers under a pairing the old one's rows don't name: they follow it, but only
 *  once the old pairing is gone, so two servers sharing a copied id never pull rows back and forth. */
export function followServerRoute(
  db: OrchestrationDb,
  asks: PairedServerAsks,
  pairedEnvironments: ReadonlySet<string>
): void {
  const announced = getAnnouncedPairing(db, asks.serverInstallationId)
  if (
    announced &&
    announced.environmentId !== asks.environmentId &&
    !pairedEnvironments.has(announced.environmentId)
  ) {
    rerouteServer(db, asks.serverInstallationId, asks.environmentId)
  }
}
