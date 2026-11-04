import { finishJournalStepsAsync } from '../native-chat/agent-session-journal/journal-reconstruction-steps'
import { z } from 'zod'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../shared/agent-sender-associations'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/agent-session/view/structured-agent-session-projection'
import {
  createCanonicalSessionResolverSteps,
  type AgentSessionRecordReader
} from './orchestration/structured-session-lineage'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { OrchestrationDb } from './orchestration/db'

export type AgentSenderPrincipal = AgentSenderPublication['principals'][number]
/** A live terminal as this host runs it now. */
export type AgentSenderPane = {
  paneKey: string
  worktreeId: string
  handle: string
  processIncarnation: string | null
}
const environmentRow = z.object({ environmentId: z.string() })

export const tolerant = <T>(schema: z.ZodType<T>, rows: unknown[]): T[] =>
  rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })

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

/** Chats with an open tab. Without a recorded tab table the store still knows the workspace's
 *  saved chat tabs, so closed history never counts as open; a reader that can't say counts all. */
async function visibleChats(records: AgentSessionRecordReader | null): Promise<Set<string> | null> {
  const listed = records?.listVisibleSessionIds?.()
  if (listed) {
    const visible = new Set<string>()
    let visits = 0
    for (const id of listed) {
      visible.add(id)
      if (++visits % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    return visible
  }
  const visibility = records?.getVisibleSessionTabIndex?.()
  return visibility?.present ? new Set(visibility.sessionIds) : null
}

/** Every open chat and, through the store's reverse /clear index, each session whose lineage
 *  reaches one: a row's chat is where its lineage runs now, so no other saved chat yields a row.
 *  Null for a reader without the index or visibility, which lists every chat. */
async function senderCandidates(
  records: AgentSessionRecordReader | null,
  visible: Set<string> | null
): Promise<Set<string> | null> {
  const clearedFrom = records?.listClearedFrom
  if (!visible || !clearedFrom) {
    return null
  }
  const seen = new Set<string>()
  const pending: string[] = []
  let visits = 0
  for (const id of visible) {
    pending.push(id)
    if (++visits % 256 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (!seen.has(id)) {
      seen.add(id)
      for (const predecessor of await clearedFrom(id)) {
        pending.push(predecessor)
        if (++visits % 256 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
      if (++visits % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
  return seen
}

/** Visible chats under their own and every /clear predecessor's session id. */
export async function readAgentSenderSessions(
  records: AgentSessionRecordReader | null,
  work?: { chatRecords: number }
): Promise<AgentSenderAssociation[]> {
  const visible = await visibleChats(records)
  const ids =
    (await senderCandidates(records, visible)) ??
    (records?.listRecords() ?? []).map((r) => r.sessionId)
  const resolve = createCanonicalSessionResolverSteps(records)
  const associations: AgentSenderAssociation[] = []
  let visits = 0
  for (const sessionId of ids) {
    if (work) {
      work.chatRecords++
    }
    const destinationId = await finishJournalStepsAsync(resolve(sessionId))
    const destination = records?.getRecord(destinationId)
    if (
      destination &&
      destination.location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
      (!visible || visible.has(destinationId))
    ) {
      associations.push({
        identity: `orca_session_id:${sessionId}`,
        paneKey: structuredAgentSessionPaneKey(
          structuredAgentSessionTabId(destinationId),
          destinationId
        ),
        worktreeId: destination.location.workspaceId,
        sessionId: destinationId
      })
    }
    if (++visits % 256 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return associations
}
