import {
  botGroupRemoteKey,
  botGroupRoom,
  type BotGroup,
  type BotGroupMessage,
  type BotGroupRemoteMember
} from '../../shared/bots/bot-group'
import { startsBotGroupRequest, type BotGroupSpeaker } from '../../shared/bots/bot-group-schema'
import type { BotGroupRuntime } from './bot-group-runtime'

export function findCurrentGroupMember(groups: readonly BotGroup[], sessionId: string) {
  for (const group of groups) {
    const member = group.members.find((entry) => entry.sessionId === sessionId)
    if (member) {
      return { group, member, threadId: undefined }
    }
    for (const thread of group.threads ?? []) {
      const found = thread.members.find((entry) => entry.sessionId === sessionId)
      if (found) {
        return { group: botGroupRoom(group, thread.id), member: found, threadId: thread.id }
      }
    }
  }
  return null
}

export function groupRouteRoot(groups: BotGroupRuntime, post: BotGroupMessage) {
  const root = post.rootRequestId ? groups.store.message(post.rootRequestId) : post
  return root &&
    root.groupId === post.groupId &&
    root.threadId === post.threadId &&
    root.sequence === (post.rootSequence ?? post.sequence) &&
    startsBotGroupRequest(root)
    ? root
    : null
}

export function groupSpeakerLabel(source: BotGroupSpeaker) {
  return source.kind === 'local'
    ? { id: source.botId, name: source.name }
    : { id: botGroupRemoteKey(source.member), name: source.member.name }
}

export function activeGroupRemoteMember(
  room: BotGroup,
  root: BotGroupMessage,
  member: BotGroupRemoteMember
): boolean {
  const cutoff = room.remoteStops?.[root.threadId ?? '']
  return (
    Math.max(cutoff?.[''] ?? 0, cutoff?.[botGroupRemoteKey(member)] ?? 0) < root.sequence &&
    (room.remoteMembers?.some(
      (current) =>
        current.environmentId === member.environmentId &&
        current.botId === member.botId &&
        current.chatSessionId === member.chatSessionId &&
        current.joinedAfter === member.joinedAfter &&
        current.joinedAfter < root.sequence
    ) ??
      false)
  )
}

export function activeGroupSpeaker(
  groups: BotGroupRuntime,
  room: BotGroup,
  root: BotGroupMessage,
  source: BotGroupSpeaker
): boolean {
  if (!groups.runtime.bots.enabled()) {
    return false
  }
  if (source.kind === 'remote') {
    return activeGroupRemoteMember(room, root, source.member)
  }
  return (
    room.members.some(
      (member) =>
        member.botId === source.botId &&
        member.sessionId === source.sessionId &&
        (member.stoppedThroughSequence ?? 0) < root.sequence
    ) && groups.runtime.bots.list().some((bot) => bot.id === source.botId && !bot.paused)
  )
}
