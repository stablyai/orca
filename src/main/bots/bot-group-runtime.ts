import type { z } from 'zod'
import type {
  BotGroup,
  BotGroupCreate,
  BotGroupSend,
  BotGroupUpdate
} from '../../shared/bots/bot-group'
import type {
  StructuredMailboxPointerHost,
  StructuredMailOwner
} from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { BotGroupStore } from './bot-group-store'
import { migrateBotGroupHomes } from './bot-group-home-migration'
import { settleStoredRoomMail } from './bot-group-remote-answers'
import {
  createBotGroup,
  createBotGroupThread,
  deleteBotGroup,
  removeBotFromGroups,
  updateBotGroup
} from './bot-group-membership'
import {
  assertGroupQueuedMessageAllowed,
  resumePendingGroupDeliveries,
  sendBotGroupMessage,
  type SendBotGroupMessageOptions
} from './bot-group-delivery'
import { readBotGroup } from './bot-group-reader'
import { stopBotGroup } from './bot-group-stop'
import { pausedBotChatHoldsMail } from './bot-paused-mail'
import {
  assertGroupPeerScope,
  liveGroupOperation,
  groupPeerScope,
  narrowGroupMailBatch,
  recordGroupWorker,
  reserveGroupMailTurn,
  type GroupPeerScope
} from './bot-group-peer-requests'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { groupAnswerTurn, saveGroupPeerAnswer } from './bot-group-peer-answer'
import { noteGroupTurnMailed } from './bot-group-mention-handoffs'
import { botGroupRoomChat } from './bot-group-automation-run'
import { nameBotGroupMemberChats } from './bot-group-member-chat-names'
import type { BotChatLookup } from '../runtime/integrations/automations/runtime-automation-target'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

const runtimes = new WeakMap<OrcaRuntimeService, BotGroupRuntime>()
export function configureBotGroupChats(
  runtime: OrcaRuntimeService,
  automation: { botChat: BotChatLookup },
  store: Pick<RuntimeStore, 'onSettingsChanged'> | null
): void {
  store?.onSettingsChanged?.((updates) => {
    const groups = runtimes.get(runtime)
    if (updates.botsEnabled === true && groups?.store.db.isOpen) {
      try {
        const host = getStructuredAgentSessionHost()
        for (const sessionId of groups.deferredContinuationSessions) {
          host?.wakeQueuedMessages(sessionId)
        }
        groups.deferredContinuationSessions.clear()
        settleStoredRoomMail(groups)
        groups.resumePending()
      } catch (error) {
        console.warn('[bot-groups] could not resume pending deliveries', error)
      }
    }
  })
  const homeChat = automation.botChat
  automation.botChat = async (bot, id) =>
    botGroupRoomChat(runtimeBotGroups(runtime), bot, id) ?? homeChat(bot, id)
}

export function runtimeBotGroups(runtime: OrcaRuntimeService): BotGroupRuntime {
  let groups = runtimes.get(runtime)
  if (!groups) {
    groups = new BotGroupRuntime(runtime)
    runtimes.set(runtime, groups)
  }
  return groups
}

/** The room a group member session talks in; null for any other session. */
export function botGroupRoomOfSession(runtime: OrcaRuntimeService, sessionId: string) {
  return isBotGroupMemberSession(sessionId)
    ? runtimeBotGroups(runtime).store.memberOf(sessionId)
    : null
}

/** A member's turn ended, so its reply is in the room: the group's home reads unread until seen.
 *  Where the host owns unread it skips a room on screen; elsewhere the open room clears it. */
export function markBotGroupRoomUnread(runtime: OrcaRuntimeService, sessionId: string): void {
  const group = botGroupRoomOfSession(runtime, sessionId)?.group
  if (!group) {
    return
  }
  const facts = runtime.sidebarFacts
  if (facts) {
    facts.sortStamps.noteWorkspaceNews(folderWorkspaceKey(group.folderWorkspaceId))
    return
  }
  void runtime
    .updateFolderWorkspace(group.folderWorkspaceId, { isUnread: true, lastActivityAt: Date.now() })
    .catch((error: unknown) => console.warn('[bot-groups] could not mark a room unread', error))
}

/** After the open returns: give groups saved before homes their own, then resume the group turns a
 *  restart left between reservation and native admission. */
/** Bot rules for a chat's mail: group rules for group members, and a paused bot's chats hold
 *  theirs; other sessions pass through. */
export function botMailOwner(runtime: OrcaRuntimeService): StructuredMailOwner {
  return {
    mailHeld: (sessionId) => pausedBotChatHoldsMail(runtime, sessionId),
    beforeSend: (input) =>
      isBotGroupMemberSession(input.sessionId) && runtimeBotGroups(runtime).reserveMailTurn(input),
    narrowBatch: (sessionId, messages) =>
      isBotGroupMemberSession(sessionId)
        ? runtimeBotGroups(runtime).narrowMailBatch(sessionId, messages)
        : { messages, ended: [] }
  }
}

export function assertBotGroupQueuedMessageAllowed(
  runtime: OrcaRuntimeService,
  sessionId: string,
  messageId: string
): void {
  if (isBotGroupMemberSession(sessionId)) {
    runtimeBotGroups(runtime).assertQueuedMessageAllowed(sessionId, messageId)
  }
}

export function startBotGroupsSoon(runtime: OrcaRuntimeService, isCurrent: () => boolean): void {
  setTimeout(() => {
    // A database closed before this ran (shutdown, tests) has nothing left to start.
    const warn = (error: unknown) => console.warn('[bot-groups] start was cut short', error)
    try {
      if (isCurrent()) {
        const groups = runtimeBotGroups(runtime)
        settleStoredRoomMail(groups)
        void migrateBotGroupHomes(groups)
          .catch(warn)
          .then(() => groups.resumePending())
          .catch(warn)
          // Chats made before member chats were named after their room.
          .then(() => nameBotGroupMemberChats(groups, undefined, { kept: true }))
          .catch(warn)
      }
    } catch (error) {
      warn(error)
    }
  }, 0).unref?.()
}

/** One host's group rooms: the store plus the per-room queue and in-flight deliveries. */
export class BotGroupRuntime {
  readonly store: BotGroupStore
  /** Serializes membership, send and stop per room. */
  readonly queues = new Map<string, Promise<void>>()
  /** Operations whose native admission is in flight. */
  readonly deliveries = new Set<string>()
  /** Native cards remain waiting in their own journal; enable only wakes these sessions. */
  readonly deferredContinuationSessions = new Set<string>()
  /** Mail turns being checked for a dead attempt, last found open, or whose chat answers for them now. */
  readonly mailTurnChecks = new Map<
    string,
    { state: 'checking' | 'answered' | 'open'; at: number }
  >()

  constructor(readonly runtime: OrcaRuntimeService) {
    this.store = new BotGroupStore(runtime.getOrchestrationDb().db)
  }

  /** Readers re-read; open rooms of `groupId` only, when it is given (a change inside one room). */
  changed(groupId?: string): void {
    this.runtime.notifyBotGroupsChanged(groupId === undefined ? undefined : [groupId])
  }

  /** Names the members' chats after their rooms, once `group` is saved with new members or names. */
  readonly named = (group: BotGroup): BotGroup => {
    void nameBotGroupMemberChats(this, [group]).catch((error: unknown) =>
      console.warn('[bot-groups] naming member chats failed', error)
    )
    return group
  }

  create = (input: z.infer<typeof BotGroupCreate>) => createBotGroup(this, input).then(this.named)
  update = (input: z.infer<typeof BotGroupUpdate>) => updateBotGroup(this, input).then(this.named)
  delete = (groupId: string) => deleteBotGroup(this, groupId)
  removeBot = (botId: string) => removeBotFromGroups(this, botId)
  send = (input: z.infer<typeof BotGroupSend>, options?: SendBotGroupMessageOptions) =>
    sendBotGroupMessage(this, input, options)
  newThread = (groupId: string) =>
    createBotGroupThread(this, groupId).then((made) => ({ ...made, group: this.named(made.group) }))
  read = (groupId: string, beforeSequence?: number, threadId?: string) =>
    readBotGroup(this, groupId, beforeSequence, threadId)
  stop = (groupId: string, botId?: string, threadId?: string) =>
    stopBotGroup(this, groupId, botId, threadId)
  resumePending = () => resumePendingGroupDeliveries(this)
  assertQueuedMessageAllowed = (sessionId: string, operationId: string) =>
    assertGroupQueuedMessageAllowed(this, sessionId, operationId)
  peerScope = (sessionId: string, targetBotId: string, rootItemId: string | null) =>
    groupPeerScope(this, sessionId, targetBotId, rootItemId)
  assertPeerScope = (scope: GroupPeerScope | null | undefined) => {
    if (scope) {
      assertGroupPeerScope(this, scope)
    }
  }
  reserveMailTurn = (input: Parameters<StructuredMailboxPointerHost['send']>[0]) =>
    reserveGroupMailTurn(this, input)
  narrowMailBatch = <T extends Pick<MessageRow, 'id' | 'thread_id' | 'from_handle'>>(
    sessionId: string,
    messages: T[]
  ) => narrowGroupMailBatch(this, sessionId, messages)
  captureWorkerOperation = (sessionId: string) => liveGroupOperation(this, sessionId)
  answerTurn = (sessionId: string, text: string) => groupAnswerTurn(this, sessionId, text)
  noteMailed = (operationId: string | undefined, botId: string) =>
    noteGroupTurnMailed(this, operationId, botId)
  saveAnswer = (operationId: string, text: string) => saveGroupPeerAnswer(this, operationId, text)
  recordWorker = (operation: Promise<string | null>, dispatchId: string) =>
    recordGroupWorker(this, operation, dispatchId)
}
