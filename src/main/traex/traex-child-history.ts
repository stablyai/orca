import type { AgentJournalProducerLinkage } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatSubagentBlock } from '../../shared/native-chat/native-chat-types'
import {
  boundSubagentLabel,
  journaledSubagent,
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../native-chat/agent-session-journal/item-lifecycle/journal-subagent-item'
import type { TraexAppServerConnection } from './traex-app-server-connection'
import type { TraexSession } from './traex-session'
import { traexChildAnnouncements } from './traex-child-work'
import { catchUpTraexHistory, readTraexTurns } from './traex-thread-history'
import { traexRecord, traexText, type TraexTurn, TraexRequestError } from './traex-protocol'
import { refreshTraexBackgroundTerminals } from './traex-background-task-stops'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'

export type TraexChildHistory = {
  threadId: string
  parentId: string
  parentTurnId: string
  label: string
  turns: TraexTurn[]
  producer: AgentJournalProducerLinkage
  live: boolean
}

export async function readTraexChildHistories(
  connection: TraexAppServerConnection,
  primaryThreadId: string,
  turns: TraexTurn[],
  check: () => void
): Promise<TraexChildHistory[]> {
  const histories: TraexChildHistory[] = []
  const visited = new Set([primaryThreadId])
  const sources = [{ id: primaryThreadId, turns }]
  for (const source of sources) {
    for (const turn of source.turns) {
      for (const item of turn.items ?? []) {
        for (const announcement of traexChildAnnouncements(item)) {
          check()
          if (visited.has(announcement.id)) {
            continue
          }
          visited.add(announcement.id)
          if (visited.size > 257) {
            throw new Error('TRAE CLI child history exceeded its bound')
          }
          let thread: Record<string, unknown>
          try {
            thread = traexRecord(
              traexRecord(
                await connection.request('thread/read', {
                  threadId: announcement.id,
                  includeTurns: false
                })
              ).thread
            )
          } catch (error) {
            if (
              error instanceof TraexRequestError &&
              /no rollout found|thread not found/.test(error.message)
            ) {
              continue
            }
            throw error
          }
          if (thread.id !== announcement.id) {
            throw new Error('TRAE CLI read a different child thread')
          }
          const childTurns = await readTraexTurns(connection, announcement.id, check)
          const label = boundSubagentLabel(
            traexText(thread.agentNickname) ??
              announcement.label ??
              traexText(thread.name) ??
              'Subagent'
          )
          const parentId = source.id
          const inherited = thread.parentThreadId != null && thread.parentThreadId !== parentId
          const cutoff = Math.max(
            ...source.turns.map((entry) => entry.completedAt ?? entry.startedAt ?? 0)
          )
          const selected = inherited
            ? childTurns.filter((entry) => (entry.completedAt ?? Infinity) <= cutoff)
            : childTurns
          histories.push({
            threadId: announcement.id,
            parentId,
            parentTurnId: turn.id,
            label,
            turns: selected,
            producer: {
              agentId: announcement.id,
              producerKind: 'agent',
              ...(parentId !== primaryThreadId ? { parentAgentId: parentId } : {})
            },
            live: !inherited && traexRecord(thread.status).type === 'active'
          })
          sources.push({ id: announcement.id, turns: selected })
        }
      }
    }
  }
  return histories
}

export function traexChildHistoryBlock(
  child: TraexChildHistory,
  sessionId: string
): NativeChatSubagentBlock {
  const last = child.turns.at(-1)
  return {
    type: 'subagent',
    id: child.threadId,
    label: child.label,
    groupId: agentJournalItemKey(
      createLegacyProviderTimelineIdentityScheme({ agent: 'trae', sessionId }).turn({
        namespace: child.parentId,
        key: { source: 'provider', value: child.parentTurnId }
      })
    ),
    state: child.live
      ? 'working'
      : last?.status === 'completed'
        ? 'completed'
        : last?.status === 'failed'
          ? 'failed'
          : last?.status === 'interrupted'
            ? 'stopped'
            : 'unverifiable',
    ...(child.producer.parentAgentId ? { parentId: child.producer.parentAgentId } : {}),
    ...(last ? { run: last.id } : {}),
    ...(last?.startedAt != null ? { startedAt: last.startedAt * 1000 } : {}),
    ...(last?.completedAt != null ? { settledAt: last.completedAt * 1000 } : {})
  }
}

export async function restoreTraexChildWork(
  session: TraexSession,
  turns: TraexTurn[],
  signal: AbortSignal
): Promise<void> {
  const children = await readTraexChildHistories(session.connection, session.threadId!, turns, () =>
    signal.throwIfAborted()
  )
  for (const child of children) {
    signal.throwIfAborted()
    await catchUpTraexHistory({
      connection: session.connection,
      threadId: child.threadId,
      primaryThreadId: session.threadId!,
      sessionId: session.input.identity.sessionId,
      sink: session.input.events!,
      signal,
      turns: child.turns,
      producer: child.producer
    })
    const saved = journaledSubagent(session.input.events!.journalItems!()!, child.threadId)
    const block = traexChildHistoryBlock(child, session.input.identity.sessionId)
    if (saved) {
      block.groupId = saved.groupId
    }
    if (saved?.tokens !== undefined && saved.run === block.run) {
      block.tokens = saved.tokens
    }
    if (JSON.stringify(saved) !== JSON.stringify(block)) {
      session.input.events!.appendItem(
        subagentJournalItemIdentity(child.threadId),
        subagentJournalBody(block),
        { turnScope: { kind: 'thread' } }
      )
    }
    if (child.live) {
      session.childWork!.register(child.threadId, child.parentId, child.label)
      const turn = child.turns.at(-1)
      if (turn) {
        session.childWork!.observe('turn/started', { threadId: child.threadId, turn })
      }
      await refreshTraexBackgroundTerminals(session, child.threadId)
    }
  }
  session.publishChildEvidence()
}
