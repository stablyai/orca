import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { RemoteComputerRefusal } from './bot-group-remote-refusal'
import type { z } from 'zod'
import {
  botGroupRemoteKey,
  type BotGroup,
  type BotGroupCreate,
  type BotGroupRemoteMember
} from '../../shared/bots/bot-group'
import type { Bot } from '../../shared/bot-types'
import {
  peerMailPairing,
  requirePeerMailServer
} from '../runtime/orchestration/federation/peer-mail/peer-mail-delivery'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { BotGroupRuntime } from './bot-group-runtime'
import { isRemoteServerUnreachable } from '../runtime/orchestration/federation/remote-owned/remote-server-unreachable'

type RemoteBots = NonNullable<z.infer<typeof BotGroupCreate>['remoteBots']>
type RemoteComputer = { name: string; pairing: string }

/** The computers a requested roster newly reaches, checked before the room's queue so a slow or
 *  offline computer never holds the room's posts and Stop: each one's name, by environment. */
export async function checkRemoteComputers(
  groups: BotGroupRuntime,
  { remoteBots: requested, groupId }: { remoteBots?: RemoteBots; groupId?: string }
): Promise<Map<string, RemoteComputer>> {
  const group = groupId === undefined ? undefined : groups.store.get(groupId)
  const kept = new Set((group?.remoteMembers ?? []).map(botGroupRemoteKey))
  const computers = new Map<string, RemoteComputer>()
  for (const environmentId of new Set(
    (requested ?? [])
      .filter((bot) => !kept.has(botGroupRemoteKey(bot)))
      .map((bot) => bot.environmentId)
  )) {
    const server = await requireRemoteComputer(groups, environmentId)
    computers.set(environmentId, { name: server.name, pairing: peerMailPairing(server) })
  }
  return computers
}

/**
 * The remote roster a create or edit saves: a room on this computer, at least one of its own bots,
 * and a joining member whose name no other member has, so mentions stay unambiguous (members who
 * already share a name, say after a rename, never block an edit). A member who joins now has seen
 * the room up to its newest post.
 */
export function resolveRemoteMembers(
  groups: BotGroupRuntime,
  localBots: readonly Bot[],
  /** The whole remote roster asked for; absent keeps the group's. */
  { remoteBots: requested }: { remoteBots?: RemoteBots },
  /** The group being edited, as its queue holds it now. */
  group: BotGroup | undefined,
  /** From `checkRemoteComputers`, for the members this edit adds. */
  computers: ReadonlyMap<string, RemoteComputer>
): BotGroupRemoteMember[] {
  const remoteBots: RemoteBots | readonly BotGroupRemoteMember[] =
    requested ?? group?.remoteMembers ?? []
  if (remoteBots.length === 0) {
    return []
  }
  if (localBots.length === 0) {
    throw new BotFailureError('groupNeedsLocalBot')
  }
  const keys = new Set(remoteBots.map(botGroupRemoteKey))
  if (keys.size !== remoteBots.length) {
    throw new BotFailureError('groupBotTwice')
  }
  const kept = new Map(
    (group?.remoteMembers ?? []).map((member) => [botGroupRemoteKey(member), member])
  )
  const wasLocal = new Set(group?.members.map((member) => member.botId))
  const named = [
    ...localBots.map((bot) => ({ name: bot.name, joining: !wasLocal.has(bot.id) })),
    // A kept member is mentioned by the name it joined with, whatever its computer calls it now.
    ...remoteBots.map((bot) => {
      const member = kept.get(botGroupRemoteKey(bot))
      return { name: member?.name ?? bot.name, joining: !member }
    })
  ]
  for (const [index, member] of named.entries()) {
    const folded = member.name.toLocaleLowerCase()
    if (
      member.joining &&
      named.some(
        // The later of two joining namesakes is the one refused.
        (other, at) =>
          at !== index &&
          (at < index || !other.joining) &&
          other.name.toLocaleLowerCase() === folded
      )
    ) {
      throw new BotFailureError('groupNameTaken', { name: member.name })
    }
  }
  const joinedAfter = group ? newestGroupSequence(groups, group) : 0
  return remoteBots.map((bot) => {
    const member = kept.get(botGroupRemoteKey(bot))
    if (member) {
      return member
    }
    const computer = computers.get(bot.environmentId)
    if (!computer) {
      throw new BotFailureError('groupChanged')
    }
    return {
      environmentId: bot.environmentId,
      botId: bot.botId,
      chatSessionId: bot.chatSessionId,
      computer: computer.name,
      pairing: computer.pairing,
      joinedAfter,
      name: bot.name,
      avatar: bot.avatar,
      ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}),
      ...(bot.avatarOutfit ? { avatarOutfit: bot.avatarOutfit } : {}),
      agent: bot.agent
    }
  })
}

/** A new group's remote roster, its computers checked first. */
export async function resolveNewGroupRemoteMembers(
  groups: BotGroupRuntime,
  localBots: readonly Bot[],
  input: { remoteBots?: RemoteBots }
): Promise<BotGroupRemoteMember[]> {
  const computers = await checkRemoteComputers(groups, input)
  return resolveRemoteMembers(groups, localBots, input, undefined, computers)
}

/** The paired computer, refused with the group's own words when its Orca can't take bot questions. */
export async function requireRemoteComputer(groups: BotGroupRuntime, environmentId: string) {
  let name = environmentId
  try {
    name = (await groups.runtime.resolveOrchestrationWorkerServer(environmentId)).name
    return await requirePeerMailServer(groups.runtime, environmentId, true, 'question')
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'server_mail_unsupported') {
      throw new BotFailureError('groupPeerTooOld', { host: name })
    }
    // Status verification may lose or retire its connection while the pairing stays valid.
    throw new RemoteComputerRefusal(
      name,
      error instanceof Error ? error.message : String(error),
      isRemoteServerUnreachable(error) ||
        (error instanceof OrchestrationError &&
          (error.code === 'runtime_unavailable' || error.code === 'runtime_environment_changed'))
    )
  }
}

/** The room's newest post across all its threads: a member joining now has seen up to here. */
export function newestGroupSequence(groups: BotGroupRuntime, group: BotGroup): number {
  return Math.max(
    0,
    ...[undefined, ...(group.threads ?? []).map((thread) => thread.id)].map(
      (threadId) => groups.store.roomMessages(group.id, threadId, 1)[0]?.sequence ?? 0
    )
  )
}
