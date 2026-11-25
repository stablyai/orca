import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { Bot } from '../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { sessionTabClosedCheck } from '../runtime/orchestration/mailbox/routing/structured-session-mail-address'
import { structuredWorkerHostScope } from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'

type BotHome = Pick<Bot, 'chatSessionId' | 'folderWorkspaceId'>
type LineageEnd = { id: string; unread?: true } | null
type LineageCache = { revision: object; ends: Map<string, LineageEnd> }

/** A missing record is distinct from one the host cannot read. */
function readChat(records: AgentSessionRecordReader, id: string) {
  try {
    if (records.isSessionUnreadable?.(id)) {
      return undefined
    }
    return records.getRecord(id) ?? (records.isSessionUnreadable ? null : undefined)
  } catch {
    return undefined
  }
}

function findLineageEnd(records: AgentSessionRecordReader, root: string): LineageEnd {
  let unread: string | null = null
  const running = resolveLineageRunningSession(
    {
      getRecord: (id) => {
        const record = readChat(records, id)
        if (!record) {
          unread = id
        }
        return record ?? null
      }
    },
    root
  )
  return running.kind === 'unverifiable'
    ? unread === null
      ? null
      : { id: unread, unread: true }
    : { id: running.sessionId }
}

/** Resolves only this bot's current idle items and Home. Retain endpoints, never the history or
 *  tab state, so a move or a reopened chat takes effect on the next turn. */
export function createBotIdleItemChatRouter() {
  const byBot = new WeakMap<BotHome, LineageCache>()
  return (
    bot: BotHome,
    records: AgentSessionRecordReader,
    turnSessionId: string,
    items: readonly { chatId: string }[]
  ): ((chatId: string) => string | null) => {
    const revision = records.lineageRevision?.()
    const previous = byBot.get(bot)
    const ends =
      previous && previous.revision === revision ? previous.ends : new Map<string, LineageEnd>()
    if (revision) {
      byBot.set(bot, { revision, ends })
    }
    const home = bot.chatSessionId
    const kept = new Set(items.map(({ chatId }) => chatId))
    for (const id of ends.keys()) {
      if (id !== home && !kept.has(id)) {
        ends.delete(id)
      }
    }
    // The running host supports keyed tab queries. An older reader cannot prove retirement cheaply.
    const closed = records.isSessionTabRetired ? sessionTabClosedCheck(records) : () => false
    const workspace = folderWorkspaceKey(bot.folderWorkspaceId)
    const endpoint = (root: string) => {
      if (!isOrcaSessionId(root)) {
        return null
      }
      if (!ends.has(root)) {
        ends.set(root, findLineageEnd(records, root))
      }
      let end = ends.get(root)
      if (!end) {
        return null
      }
      let record = readChat(records, end.id)
      // A missing successor can appear without changing an older record or the lineage revision.
      if (end.unread && record) {
        ends.set(root, findLineageEnd(records, end.id))
        end = ends.get(root)
        if (!end) {
          return null
        }
        record = readChat(records, end.id)
      }
      if (record === null && end.id === root) {
        return { kind: 'gone' as const }
      }
      if (
        !record ||
        record.location.workspaceId !== workspace ||
        record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
        (record.sessionId !== turnSessionId && !structuredWorkerHostScope(record.location))
      ) {
        return null
      }
      return closed(record.sessionId)
        ? { kind: 'gone' as const }
        : { kind: 'open' as const, id: record.sessionId }
    }
    let homeOnThisTurn: boolean | undefined
    return (chatId) => {
      const owner = endpoint(chatId)
      if (owner?.kind === 'open') {
        return owner.id
      }
      if (owner?.kind !== 'gone' || !home) {
        return null
      }
      if (homeOnThisTurn === undefined) {
        const current = endpoint(home)
        homeOnThisTurn = current?.kind === 'open' && current.id === turnSessionId
      }
      return homeOnThisTurn ? turnSessionId : null
    }
  }
}
