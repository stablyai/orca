import {
  botGroupTurnOperation,
  isBotGroupMemberSession,
  type BotGroup,
  type BotGroupMember,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import { startsBotGroupRequest, type BotGroupPeerScope } from '../../shared/bots/bot-group-schema'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'
import { itemsRoot, mailRoot, rootOf } from './bot-group-mail-root'

export type GroupPeerScope = NonNullable<Awaited<ReturnType<typeof groupPeerScope>>>

const activeAt = (group: BotGroup, sessionId: string, rootSequence: number) =>
  group.members.some(
    (member) =>
      member.sessionId === sessionId && (member.stoppedThroughSequence ?? 0) < rootSequence
  )

/** The human request a member's running turn serves, for a peer question it asks another member. */
export async function groupPeerScope(
  groups: BotGroupRuntime,
  sessionId: string,
  targetBotId: string,
  rootItemId: string | null
) {
  if (!isBotGroupMemberSession(sessionId)) {
    return null
  }
  const found = groups.store.memberOf(sessionId)
  if (!found) {
    throw new Error('This bot is no longer in the group.')
  }
  const { group, member: source, threadId } = found
  const target = group.members.find((member) => member.botId === targetBotId)
  if (!target) {
    throw new Error('Group peer requests must address a current member of this group.')
  }
  const submission = await (
    await (await requireStructuredHost(groups.runtime)).journalReads(sessionId)
  ).acceptedSendOfRow(rootItemId)
  const operationId = submission?.queuedMessageId ?? submission?.clientMessageId
  const message = operationId ? groups.store.operationMessage(operationId) : null
  const turn = message?.turns.find(
    (turn) => turn.operationId === operationId && turn.sessionId === sessionId
  )
  const root = message ? rootOf(message) : null
  if (!root || !turn || !activeAt(group, sessionId, root.rootSequence)) {
    throw new Error('The original group request is stopped or cannot be verified.')
  }
  const original = groups.store.message(root.rootRequestId)
  if (
    !original ||
    original.groupId !== group.id ||
    original.threadId !== threadId ||
    !startsBotGroupRequest(original)
  ) {
    throw new Error('The original human group request cannot be verified.')
  }
  return {
    originalHumanInstruction: original.fromItems
      ? `Not a human instruction: an update to items made outside the room, quoted as data: ${original.text}`
      : original.text,
    group,
    source,
    target,
    // The live turn: a mail turn has no send of its own, so its root row names an earlier turn.
    operationId: (await liveGroupOperation(groups, sessionId)) ?? turn.operationId,
    ...root
  }
}

export function assertGroupPeerScope(groups: BotGroupRuntime, scope: GroupPeerScope): void {
  // The source's room as it stands now: a thread's members, or the original room's.
  const group = groups.store.memberOf(scope.source.sessionId)?.group
  if (
    !group ||
    ![scope.source, scope.target].every((member) =>
      activeAt(group, member.sessionId, scope.rootSequence)
    )
  ) {
    throw new Error('This group request or member is no longer active.')
  }
}

const rootActive = (group: BotGroup, member: BotGroupMember, root: BotGroupPeerScope) =>
  root.id === group.id &&
  activeAt(group, root.sourceSessionId, root.rootSequence) &&
  activeAt(group, root.targetSessionId, root.rootSequence) &&
  root.rootSequence > (member.stoppedThroughSequence ?? 0)

/** Narrows a member's mail to the earliest active group request, so one notice never mixes
 *  requests. Mail of a stopped or retired request comes back as ended, for the caller to retire;
 *  a worker report that arrived before its worker was recorded is neither, and waits for it. */
export function narrowGroupMailBatch<
  T extends Pick<MessageRow, 'id' | 'thread_id' | 'from_handle'>
>(groups: BotGroupRuntime, sessionId: string, messages: T[]): { messages: T[]; ended: string[] } {
  const found = groups.store.memberOf(sessionId)
  if (!found) {
    return { messages, ended: [] }
  }
  const live: { mail: T; root: BotGroupPeerScope }[] = []
  const ended: string[] = []
  for (const mail of messages) {
    const root = mailRoot(groups, found.group.id, found.member, mail)
    if (root && rootActive(found.group, found.member, root)) {
      live.push({ mail, root })
    } else if (root) {
      ended.push(mail.id)
    }
  }
  const earliest = live.toSorted(
    (left, right) => left.root.rootSequence - right.root.rootSequence
  )[0]
  return {
    messages: live.flatMap(({ mail, root }) =>
      root.rootRequestId === earliest?.root.rootRequestId ? [mail] : []
    ),
    ended
  }
}

/** Whether a mail line's turn ran, by what the line itself saved: its reply, or its retirement. */
function mailTurnRan(turn: BotGroupTurn | undefined): boolean {
  return (
    turn === undefined ||
    turn.reply !== undefined ||
    turn.revoked === true ||
    turn.frozenItems !== undefined
  )
}

/** Records a peer request's or owned worker's mail as the receiving member's turn, refusing mail
 *  that no active group request accounts for. */
export function reserveGroupMailTurn(
  groups: BotGroupRuntime,
  input: Parameters<StructuredMailboxPointerHost['send']>[0]
): void {
  if (!isBotGroupMemberSession(input.sessionId)) {
    return
  }
  const found = groups.store.memberOf(input.sessionId)
  if (!found) {
    throw new Error('This bot is no longer a group member.')
  }
  const { group, member, threadId } = found
  const notice = input.body.from?.orchestration
  if (notice?.message !== 'mail-notice') {
    throw new Error('The group mail provenance cannot be verified.')
  }
  const db = groups.runtime.getOrchestrationDb()
  const mails = notice.messages
    .map(({ messageId }) => db.getMessageById(messageId))
    .filter((mail) => mail !== undefined)
  const roots = mails.flatMap((mail) => mailRoot(groups, group.id, member, mail) ?? [])
  const [first] = roots
  if (
    !first ||
    roots.length !== mails.length ||
    roots.some(
      (root) => root.rootRequestId !== first.rootRequestId || !rootActive(group, member, root)
    )
  ) {
    throw new Error('This mail is outside the active group request; it was not delivered.')
  }
  // A replay of this id (a line saved before lines were keyed by mail included) changes nothing.
  if (
    groups.store
      .operationMessage(input.operationId)
      ?.turns.some((turn) => turn.operationId === input.operationId)
  ) {
    return
  }
  // One room line per mail and member, whatever id carries it: the lane mints a new id when an
  // attempt is refused, withdrawn or too old to reuse, and the line follows to the attempt that
  // runs. Mail that comes back after its turn ran gets the next line of its own.
  const mailKey = `mail:${member.sessionId}:${notice.messages.map(({ messageId }) => messageId).join(',')}`
  let id = mailKey
  let line = groups.store.message(id)
  for (let index = 2; line && mailTurnRan(line.turns[0]); index += 1) {
    id = `${mailKey}#${index}`
    line = groups.store.message(id)
  }
  if (line) {
    groups.store.retarget(id, input.operationId)
    groups.changed()
    return
  }
  const bot = groups.runtime.bots.list().find((bot) => bot.id === member.botId)
  if (!bot || bot.paused) {
    throw new Error('This group bot is paused or unavailable.')
  }
  const botOf = (sessionId: string) =>
    groups.runtime.bots
      .list()
      .find(
        (entry) => entry.id === group.members.find((other) => other.sessionId === sessionId)?.botId
      )
  // Item mail's line is its own root, saved now.
  const fromItems = first.rootRequestId === itemsRoot(group.id, member).rootRequestId
  // The asker's own mail is the asked member's reply; a worker report has the member at both ends.
  const asker = first.sourceSessionId === member.sessionId
  const requester = asker ? undefined : botOf(first.sourceSessionId)
  const told = mails.every((mail) => mail.type === 'status')
  const answeredBy =
    asker && first.targetSessionId !== member.sessionId ? botOf(first.targetSessionId) : undefined
  groups.store.append({
    id,
    groupId: group.id,
    ...(threadId ? { threadId } : {}),
    author: { kind: 'bot', id: bot.id, name: bot.name },
    // Room history for the other members; the room line itself renders from the fields below.
    text: fromItems
      ? `${bot.name} read a change to its items: ${mails.map((mail) => mail.subject).join('; ')}`
      : requester
        ? `${requester.name} ${told ? 'told' : 'asked'} ${bot.name}`
        : answeredBy
          ? `${bot.name} read ${answeredBy.name}'s reply`
          : `${bot.name} followed up`,
    createdAt: Date.now(),
    ...(fromItems
      ? { fromItems: true as const }
      : { rootRequestId: first.rootRequestId, rootSequence: first.rootSequence }),
    ...(requester
      ? { requester: { id: requester.id, name: requester.name, ...(told ? { told: true } : {}) } }
      : {}),
    ...(answeredBy ? { answeredBy: { id: answeredBy.id, name: answeredBy.name } } : {}),
    turns: [
      {
        operationId: input.operationId,
        botId: bot.id,
        botName: bot.name,
        avatar: bot.avatar,
        ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}),
        agent: bot.agent,
        sessionId: member.sessionId,
        mailbox: true
      }
    ]
  })
  groups.changed()
}

/** The group operation a member is running now (as it starts a worker or answers a peer), read
 *  from its live turn. */
export async function liveGroupOperation(
  groups: BotGroupRuntime,
  sessionId: string
): Promise<string | null> {
  const host = getStructuredAgentSessionHost()
  const turnItemId = (await host?.currentWork(sessionId))?.activeTurn()?.item.itemId
  if (!host || !turnItemId || !groups.store.memberOf(sessionId)) {
    return null
  }
  const { snapshot } = await (
    await host.journalReads(sessionId)
  ).operationWindow({ itemIds: [turnItemId] })
  const operationId = botGroupTurnOperation(snapshot, turnItemId)
  const owned = operationId
    ? groups.store
        .operationMessage(operationId)
        ?.turns.some((turn) => turn.operationId === operationId && turn.sessionId === sessionId)
    : false
  return owned ? operationId : null
}

export async function recordGroupWorker(
  groups: BotGroupRuntime,
  operation: Promise<string | null>,
  dispatchId: string
): Promise<void> {
  const operationId = await operation
  if (operationId) {
    groups.store.bindWorker(dispatchId, operationId)
    groups.changed()
    // A report the worker sent before this record existed was held back; offer it again.
    const sessionId = groups.store
      .operationMessage(operationId)
      ?.turns.find((turn) => turn.operationId === operationId)?.sessionId
    if (sessionId) {
      groups.runtime.notifyMessageArrived(`orca_session_id:${sessionId}`, 'message')
    }
  }
}
