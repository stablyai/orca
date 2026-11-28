import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { Bot } from '../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { sessionTabClosedCheck } from '../runtime/orchestration/mailbox/routing/structured-session-mail-address'
import { createIdleItemLineageReader, readIdleItemChat } from './bot-idle-item-lineage'

type BotHome = Pick<Bot, 'id' | 'chatSessionId' | 'folderWorkspaceId'>

/** Resolve only this bot's idle items and Home. Tab state and location are live on each turn. */
export function createBotIdleItemChatRouter() {
  const lineage = createIdleItemLineageReader()
  return (
    bot: BotHome,
    records: AgentSessionRecordReader,
    turnSessionId: string,
    items: readonly { chatId: string }[],
    roster?: readonly { id: string }[]
  ): ((chatId: string) => string | null) => {
    const home = bot.chatSessionId
    const kept = new Set(items.map(({ chatId }) => chatId))
    if (home && kept.size) {
      kept.add(home)
    }
    const readEnd = lineage(records, bot.id, kept, roster)
    // The running host supports keyed tab queries. An older reader cannot prove retirement cheaply.
    const closed = records.isSessionTabRetired ? sessionTabClosedCheck(records) : () => false
    const workspace = folderWorkspaceKey(bot.folderWorkspaceId)
    const endpoint = (root: string) => {
      if (!isOrcaSessionId(root)) {
        return null
      }
      let end = readEnd(root)
      if (!end) {
        return null
      }
      let record = readIdleItemChat(records, end.id)
      // A missing successor can appear without changing an older record or the lineage revision.
      if (end.unread && record) {
        end = readEnd(root, true)
        if (!end) {
          return null
        }
        record = readIdleItemChat(records, end.id)
      }
      if (record === null && end.id === root) {
        return { kind: 'gone' as const }
      }
      if (
        !record ||
        record.location.workspaceId !== workspace ||
        record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID
      ) {
        return null
      }
      return record.sessionId !== turnSessionId && closed(record.sessionId)
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
