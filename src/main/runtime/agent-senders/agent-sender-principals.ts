import { observeEnvironmentStoreReads } from '../../../shared/remote-runtime/host-store/runtime-environment-store-read-observation'
import { readAgentSenderGeneration } from './runtime-agent-sender-history-triggers'
import type { Dependencies } from './runtime-agent-sender-dependencies'
import 'node:crypto'
import '../../../shared/orchestration/workers/structured-worker-handle'
import '../../../shared/workspace-layout/stable-pane-id'
import '../../../shared/orchestration/workers/worker-terminal-host-scope'
import { z } from 'zod'
import '../../../shared/agent-session/view/structured-agent-session-projection'
import '../orchestration/addressing/session-lineage/structured-session-lineage'
import '../../../shared/execution-host'
import type { AgentSenderPublication } from '../../../shared/agent-sender-associations'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { tolerant } from './agent-sender-row-decoding'

export type AgentSenderPrincipal = AgentSenderPublication['principals'][number]

const environmentRow = z.object({ environmentId: z.string() })

/** One principal per paired peer, not one route per federated Dispatch ever made. */
export async function readAgentSenderPrincipals(
  db: OrchestrationDb,
  principal: (
    environmentId: string
  ) => AgentSenderPrincipal | undefined | Promise<AgentSenderPrincipal | undefined>
): Promise<AgentSenderPrincipal[]> {
  const environments = tolerant(
    environmentRow,
    db.db.prepare('SELECT DISTINCT environment_id AS environmentId FROM federated_dispatches').all()
  )
  const peers = await Promise.all(environments.map(({ environmentId }) => principal(environmentId)))
  return peers.filter((peer): peer is AgentSenderPrincipal => peer !== undefined)
}

export async function prepareAgentSenderPrincipals(
  deps: Dependencies,
  cached: {
    db: OrchestrationDb | null
    generation: string
    pairing: number
    values: AgentSenderPrincipal[]
  }
): Promise<{ values: AgentSenderPrincipal[]; current: () => boolean }> {
  const db = deps.getDb()
  const pairing = deps.pairingGeneration()
  const generation = db ? readAgentSenderGeneration(db, db !== cached.db).principals : ''
  const reusable =
    db === cached.db && generation === cached.generation && pairing === cached.pairing
  const observation =
    !db || reusable
      ? undefined
      : await observeEnvironmentStoreReads(
          () => readAgentSenderPrincipals(db, deps.principal),
          deps.pairingGeneration
        )
  const observedPairing = observation?.generation ?? pairing
  return {
    values: observation?.value ?? (db ? cached.values : []),
    current: () =>
      deps.getDb() === db &&
      deps.pairingGeneration() === observedPairing &&
      (!observation || observation.current) &&
      (!db || readAgentSenderGeneration(db, false).principals === generation)
  }
}
