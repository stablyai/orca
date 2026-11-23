import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import {
  botGroupRoomMembers,
  indexBotGroupJournal,
  type BotGroup,
  type BotGroupCreate,
  type BotGroupMember,
  type BotGroupUpdate
} from '../../shared/bots/bot-group'
import type { Bot } from '../../shared/bot-types'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { requireStructuredHost, startBotSession } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The bots behind these ids, refusing duplicates and bots this host cannot run in a room. */
export function requireGroupBots(groups: BotGroupRuntime, ids: readonly string[]): Bot[] {
  groups.runtime.bots.assertEnabled()
  if (new Set(ids).size !== ids.length) {
    throw new Error('Choose each bot once.')
  }
  return ids.map((id) => {
    const bot = groups.runtime.bots.list().find((bot) => bot.id === id)
    if (!bot) {
      throw new Error('A selected bot is no longer available.')
    }
    if (bot.hostId !== 'local') {
      throw new Error('Groups currently support bots on this local execution host only.')
    }
    return bot
  })
}

export async function createBotGroup(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupCreate>
): Promise<BotGroup> {
  const bots = requireGroupBots(groups, input.botIds)
  const id = randomUUID()
  const members = await startMembers(groups, bots)
  let home: Awaited<ReturnType<typeof groups.runtime.bots.createGroupHome>> | null = null
  try {
    home = await groups.runtime.bots.createGroupHome(input.name, bots[0].agent)
    const group: BotGroup = {
      id,
      name: input.name,
      hostId: 'local',
      revision: 1,
      ...home,
      members,
      replyMode: { kind: 'bot', botId: bots[0].id },
      createdAt: Date.now()
    }
    groups.store.put(group)
    groups.changed()
    return group
  } catch (error) {
    await closeSessions(groups, members)
    if (home) {
      await groups.runtime.deleteFolderWorkspace(home.folderWorkspaceId)
    }
    throw error
  }
}

export function updateBotGroup(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupUpdate>
): Promise<BotGroup> {
  return runKeyedSerializedOperation(groups.queues, input.groupId, async () => {
    const previous = groups.store.get(input.groupId)
    if (previous.revision !== input.revision) {
      throw new Error('The group changed. Reopen this dialog and try again.')
    }
    const bots = requireGroupBots(
      groups,
      input.botIds ?? previous.members.map((member) => member.botId)
    )
    const joiningBots = bots.filter(
      (bot) => !previous.members.some((member) => member.botId === bot.id)
    )
    // A bot that joins gets a session in every room, as each room's members do.
    const joining: BotGroupMember[][] = []
    try {
      if (joiningBots.length > 0) {
        for (const _room of botGroupRoomMembers(previous)) {
          joining.push(await startMembers(groups, joiningBots))
        }
      }
      const roster = (room: readonly BotGroupMember[], fresh: readonly BotGroupMember[]) =>
        bots.flatMap(
          (bot) =>
            room.find((member) => member.botId === bot.id) ??
            fresh.find((member) => member.botId === bot.id) ??
            []
        )
      const replyMode = input.replyMode ?? previous.replyMode
      if (
        replyMode.kind === 'bot' &&
        input.replyMode &&
        !bots.some((bot) => bot.id === replyMode.botId)
      ) {
        throw new Error('Choose a current member in Room replies.')
      }
      return await retireMembers(groups, {
        ...previous,
        name: input.name ?? previous.name,
        members: roster(previous.members, joining[0] ?? []),
        ...(previous.threads && {
          threads: previous.threads.map((thread, index) => ({
            ...thread,
            members: roster(thread.members, joining[index + 1] ?? [])
          }))
        }),
        replyMode
      })
    } catch (error) {
      await closeSessions(groups, joining.flat())
      throw error
    }
  })
}

/** A deleted bot leaves every room as a membership removal would. */
export async function removeBotFromGroups(groups: BotGroupRuntime, botId: string): Promise<void> {
  const staying = (member: BotGroupMember) => member.botId !== botId
  for (const { id } of groups.store.list()) {
    await runKeyedSerializedOperation(groups.queues, id, async () => {
      const previous = groups.store.get(id)
      if (!previous.members.every(staying)) {
        await retireMembers(groups, {
          ...previous,
          members: previous.members.filter(staying),
          ...(previous.threads && {
            threads: previous.threads.map((thread) => ({
              ...thread,
              members: thread.members.filter(staying)
            }))
          })
        })
      }
    })
  }
}

/** Another room in the group: every current member on a fresh session, as a new chat starts. */
export function createBotGroupThread(
  groups: BotGroupRuntime,
  groupId: string
): Promise<{ group: BotGroup; threadId: string }> {
  return runKeyedSerializedOperation(groups.queues, groupId, async () => {
    const previous = groups.store.get(groupId)
    if (previous.members.length === 0) {
      throw new Error('Every bot has left this group. Add a bot before starting a thread.')
    }
    const members = await startMembers(
      groups,
      requireGroupBots(
        groups,
        previous.members.map((member) => member.botId)
      )
    )
    const threadId = `bot-group-thread-${randomUUID()}`
    const group: BotGroup = {
      ...previous,
      threads: [...(previous.threads ?? []), { id: threadId, createdAt: Date.now(), members }]
    }
    try {
      groups.store.put(group)
    } catch (error) {
      await closeSessions(groups, members)
      throw error
    }
    groups.changed()
    return { group, threadId }
  })
}

/** Removes the room's rows first, so no queued turn is admitted while its sessions close. */
export function deleteBotGroup(groups: BotGroupRuntime, groupId: string): Promise<void> {
  return runKeyedSerializedOperation(groups.queues, groupId, async () => {
    const group = groups.store.get(groupId)
    groups.store.deleteGroup(groupId)
    groups.changed()
    await closeSessions(groups, botGroupRoomMembers(group).flat())
    await groups.runtime.deleteFolderWorkspace(group.folderWorkspaceId)
  })
}

/** Saves `next` as the following revision; members it dropped keep their turns frozen as
 *  they stood, and their sessions close. A default that left falls back to mentions only. */
async function retireMembers(groups: BotGroupRuntime, next: BotGroup): Promise<BotGroup> {
  const previous = groups.store.get(next.id)
  const { replyMode } = next
  const group: BotGroup = {
    ...withFormerSessions(previous, next),
    revision: previous.revision + 1,
    replyMode:
      replyMode.kind === 'bot' && !next.members.some((member) => member.botId === replyMode.botId)
        ? { kind: 'mentions' }
        : replyMode
  }
  const kept = new Set(
    botGroupRoomMembers(group)
      .flat()
      .map((member) => member.sessionId)
  )
  const leaving = botGroupRoomMembers(previous)
    .flat()
    .filter((old) => !kept.has(old.sessionId))
  if (leaving.length === 0) {
    groups.store.put(group)
    groups.changed()
    return group
  }
  const host = await requireStructuredHost(groups.runtime)
  const frozen = new Map<string, ReturnType<typeof indexBotGroupJournal>>()
  const messages = groups.store.messages(group.id, Number.MAX_SAFE_INTEGER)
  for (const { sessionId } of leaving) {
    // Only the turns the member ran in this room, and the rows that place them.
    const operationIds = messages.flatMap((message) =>
      message.turns.flatMap((turn) => (turn.sessionId === sessionId ? [turn.operationId] : []))
    )
    const { snapshot } = await (
      await host.journalReads(sessionId)
    ).operationWindow({ operationIds })
    frozen.set(sessionId, indexBotGroupJournal(snapshot))
  }
  groups.store.transaction(() => {
    groups.store.put(group)
    for (const message of groups.store.messages(group.id, Number.MAX_SAFE_INTEGER)) {
      const retired = message.turns.filter((turn) => frozen.has(turn.sessionId))
      if (retired.length === 0) {
        continue
      }
      // A retired turn is owed nothing more, so its pending send goes with it.
      groups.store.delivered(retired.map((turn) => turn.operationId))
      groups.store.update({
        ...message,
        turns: message.turns.map((turn) => {
          const read = frozen.get(turn.sessionId)
          return read
            ? {
                ...turn,
                revoked: true,
                frozenItems: read(turn.operationId, turn.workerDispatchIds)
              }
            : turn
        })
      })
    }
  })
  await closeSessions(groups, leaving)
  groups.changed()
  return group
}

/** Each room remembers the sessions that left it, so its Session History rows still open it. */
function withFormerSessions(previous: BotGroup, next: BotGroup): BotGroup {
  type Room = Pick<BotGroup, 'members' | 'formerSessionIds'>
  const remember = <T extends Room>(room: T, before: Room | undefined): T => {
    const left = (before?.members ?? [])
      .map((member) => member.sessionId)
      .filter((sessionId) => !room.members.some((member) => member.sessionId === sessionId))
    return left.length === 0
      ? room
      : { ...room, formerSessionIds: [...(room.formerSessionIds ?? []), ...left] }
  }
  return {
    ...remember(next, previous),
    ...(next.threads && {
      threads: next.threads.map((thread) =>
        remember(
          thread,
          previous.threads?.find((entry) => entry.id === thread.id)
        )
      )
    })
  }
}

/** One background native session per bot; if any fails to start, the others close. */
async function startMembers(
  groups: BotGroupRuntime,
  bots: readonly Bot[]
): Promise<BotGroupMember[]> {
  const started = await Promise.allSettled(
    bots.map(async (bot) => ({
      botId: bot.id,
      sessionId: await startBotSession(groups.runtime, bot, {
        sessionId: `bot-group-member-${randomUUID()}`,
        background: true
      })
    }))
  )
  const members = started.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const failed = started.find((result) => result.status === 'rejected')
  if (failed) {
    await closeSessions(groups, members)
    throw failed.reason
  }
  return members
}

async function closeSessions(
  groups: BotGroupRuntime,
  sessions: readonly Pick<BotGroupMember, 'sessionId'>[]
): Promise<void> {
  // Settled, so one session that will not close never leaves the others open.
  await Promise.allSettled(
    sessions.map(({ sessionId }) =>
      closeStructuredAgentSessionChild(sessionId, { runtime: groups.runtime })
    )
  )
}
