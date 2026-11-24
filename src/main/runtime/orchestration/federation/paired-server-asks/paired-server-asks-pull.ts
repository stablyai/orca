// This computer takes asks from agents on a server it is paired to only when that server can send
// them: the server's status is read once per pairing (again when it turns verified), and each pull
// loop names itself on every pull of a session.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { PeerMailClientAsksPull } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { getPublishedHostDescriptor } from '../../../hosts/platform-probe/host-descriptor'
import { peerMailPairing } from '../peer-mail/peer-mail-delivery'
import type { OrchestrationWorkerServer } from '../environment-transport'
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
  /** The server's host key fingerprint: what this computer keeps its choices about it by. Its
   *  installation id is self-reported, so another server could claim it. */
  serverKey: string
  /** The credential this computer is paired to the server with now. */
  pairing: string
  /** The pairing's revision these asks were read under: a return sent under it can't reach a
   *  pairing that replaced it. */
  pairingRevision?: number
  wire: z.infer<typeof PeerMailClientAsksPull>
}

type Runtime = Pick<
  OrcaRuntimeService,
  | 'getRuntimeId'
  | 'readMachineName'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
>

/** What the server said it can do under one pairing: null when it can't send asks. */
export type ServerAsksSupport = { serverInstallationId: string } | null

type SupportRead = { pairing: string; read: Promise<ServerAsksSupport>; value?: ServerAsksSupport }

const pairingKey = (server: OrchestrationWorkerServer): string =>
  `${server.pairingRevision ?? ''}\0${peerMailPairing(server)}`

// Per runtime, per server: shared by the announce step and every loop, so neither reads it again.
const supportByRuntime = new WeakMap<object, Map<string, SupportRead>>()

/** The server's answer as read already under its current pairing; undefined when not read yet. */
export function knownServerAsksSupport(
  runtime: Runtime,
  server: OrchestrationWorkerServer
): ServerAsksSupport | undefined {
  const known = supportByRuntime.get(runtime)?.get(server.environmentId)
  return known && known.pairing === pairingKey(server) ? known.value : undefined
}

/** Reads the server's status, or shares the read under way; a failed read is not kept. */
export function readServerAsksSupport(
  runtime: Runtime,
  server: OrchestrationWorkerServer,
  options: { fresh?: boolean } = {}
): Promise<ServerAsksSupport> {
  const known = supportByRuntime.get(runtime) ?? new Map<string, SupportRead>()
  supportByRuntime.set(runtime, known)
  const current = known.get(server.environmentId)
  if (current && current.pairing === pairingKey(server) && !options.fresh) {
    return current.read
  }
  const entry: SupportRead = {
    pairing: pairingKey(server),
    read: statusSupport(runtime, server)
  }
  known.set(server.environmentId, entry)
  entry.read.then(
    (value) => {
      entry.value = value
    },
    () => {
      if (known.get(server.environmentId) === entry) {
        known.delete(server.environmentId)
      }
    }
  )
  return entry.read
}

async function statusSupport(
  runtime: Runtime,
  server: OrchestrationWorkerServer
): Promise<ServerAsksSupport> {
  const status = ServerStatus.safeParse(
    await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'status.get',
      undefined,
      STATUS_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
  )
  const serverInstallationId = status.success ? status.data.hostDescriptor?.installationId : null
  return serverInstallationId &&
    status.data?.capabilities?.includes(ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY)
    ? { serverInstallationId }
    : null
}

/** What a pull loop names itself with on this server; null when the server can't send asks, or this
 *  computer or the server has no installation id yet (unverified), so the loop pulls as before.
 *  Rejects when the server's status can't be read now. */
export async function pairedServerAsksFor(
  runtime: Runtime,
  db: OrchestrationDb,
  environmentId: string,
  options: { fresh?: boolean; server?: OrchestrationWorkerServer } = {}
): Promise<PairedServerAsks | null> {
  const installationId = getPublishedHostDescriptor(runtime.getRuntimeId())?.installationId
  if (!installationId) {
    return null
  }
  const server = options.server ?? (await runtime.resolveOrchestrationWorkerServer(environmentId))
  const support = await readServerAsksSupport(runtime, server, options)
  if (!support) {
    return null
  }
  const serverKey = server.peerFingerprint
  const pairing = peerMailPairing(server)
  const announced = getAnnouncedPairing(db, serverKey)
  // Named once a later pairing replaced it, so the server ends only that pairing's mail.
  const previousPairing =
    announced && announced.pairingFingerprint !== pairing
      ? announced.serverSeenFingerprint
      : undefined
  return {
    environmentId,
    serverName: server.name,
    serverKey,
    pairing,
    ...(server.pairingRevision !== undefined ? { pairingRevision: server.pairingRevision } : {}),
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
  return getAnnouncedPairing(db, asks.serverKey)?.pairingFingerprint !== asks.pairing
}

/** The server answered under this pairing: it is announced, and when it replaced an earlier one,
 *  what any other pairing of this server left here ends in the same write: its owed replies are retired (the server told their
 *  askers when it ended that pairing) and its held asks go unanswered, since no answer could go
 *  back. A failed write leaves the announcement owed, so the next answered pull settles them.
 *  Returns the agents whose waiting cards went. */
export function noteAnnounced(
  db: OrchestrationDb,
  asks: PairedServerAsks,
  seenAs: string
): string[] {
  const earlier = getAnnouncedPairing(db, asks.serverKey)
  const dropped = runLifecycleWriteTransaction(db.db, 'paired_server_announced', () => {
    recordAnnouncedPairing(db, asks.serverKey, {
      environmentId: asks.environmentId,
      pairingFingerprint: asks.pairing,
      serverSeenFingerprint: seenAs
    })
    if (
      !earlier ||
      (earlier.pairingFingerprint === asks.pairing && earlier.serverSeenFingerprint === seenAs)
    ) {
      return []
    }
    db.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = datetime('now')
         WHERE direction = 'to_home' AND acked_at IS NULL AND dispatch_id IN (
           SELECT conversation_id FROM paired_server_owed_returns
           WHERE environment_id = ? AND peer_fingerprint <> ?)`
      )
      .run(asks.environmentId, asks.pairing)
    // Held under a conversation of another pairing (or none this computer can name): dropped.
    const stale = `FROM paired_server_asks AS a
      WHERE a.environment_id = ?1 AND NOT EXISTS (
        SELECT 1 FROM peer_mail_conversations c
        WHERE c.conversation_id = a.conversation_id AND c.role = 'peer'
          AND c.peer_fingerprint = ?2)`
    const cards = db.db
      .prepare(`SELECT a.bot_id ${stale} AND a.state = 'card'`)
      .all(asks.environmentId, asks.pairing)
      .map((row) => String(row.bot_id))
    db.db.prepare(`DELETE ${stale}`).run(asks.environmentId, asks.pairing)
    return cards
  })
  delete asks.wire.previousPairing
  return [...new Set(dropped)]
}

/** The same server answers under a pairing the old one's rows don't name: they follow it, but only
 *  once the old pairing is gone, so two pairings to one server never pull rows back and forth. */
export function followServerRoute(
  db: OrchestrationDb,
  asks: PairedServerAsks,
  pairedEnvironments: ReadonlySet<string>
): void {
  const announced = getAnnouncedPairing(db, asks.serverKey)
  if (
    announced &&
    announced.environmentId !== asks.environmentId &&
    !pairedEnvironments.has(announced.environmentId)
  ) {
    rerouteServer(db, asks.serverKey, asks.environmentId)
  }
}
