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
export function readAgentSenderPrincipals(
  db: OrchestrationDb,
  principal: (environmentId: string) => AgentSenderPrincipal | undefined
): AgentSenderPrincipal[] {
  return tolerant(
    environmentRow,
    db.db.prepare('SELECT DISTINCT environment_id AS environmentId FROM federated_dispatches').all()
  ).flatMap(({ environmentId }) => {
    const peer = principal(environmentId)
    return peer ? [peer] : []
  })
}
