import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { AgentPaneWorkspace } from '../agent-hooks/observations/agent-transition-detector'
import type { ConversationKey } from './external-conversation-types'

export type LinkedConversation<L extends ExternalConversationLink = ExternalConversationLink> = {
  workspace: AgentPaneWorkspace
  link: L
}

export const EMPTY_LINKED: readonly LinkedConversation[] = []

export function conversationIndexKey(key: ConversationKey): string {
  return `${key.source}\0${key.externalId}`
}

export function workspaceIndexKey({ worktreeId, sshHostId }: AgentPaneWorkspace): string {
  return `${sshHostId ?? ''}\0${worktreeId}`
}

export function pushBucketEntry<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) {
    existing.push(value)
  } else {
    map.set(key, [value])
  }
}

export function groupEntriesByKey(
  entries: readonly LinkedConversation[],
  keyOf: (entry: LinkedConversation) => string
): Map<string, LinkedConversation[]> {
  const grouped = new Map<string, LinkedConversation[]>()
  for (const entry of entries) {
    pushBucketEntry(grouped, keyOf(entry), entry)
  }
  return grouped
}

export function sameEntrySlice(
  left: readonly LinkedConversation[] | undefined,
  right: readonly LinkedConversation[] | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  )
}

export function updateKeyBucket(
  map: Map<string, LinkedConversation[]>,
  key: string,
  wsKey: string,
  mine: LinkedConversation[],
  ranks: ReadonlyMap<string, number>
): boolean {
  const existing = map.get(key)
  const others = existing
    ? existing.filter((entry) => workspaceIndexKey(entry.workspace) !== wsKey)
    : EMPTY_LINKED
  if (others.length === 0) {
    if (mine.length > 0) {
      map.set(key, mine)
    } else if (existing) {
      map.delete(key)
    }
    return true
  }
  if (mine.length === 0) {
    map.set(key, [...others])
    return true
  }
  if (!ranks.has(wsKey) || others.some((entry) => !ranks.has(workspaceIndexKey(entry.workspace)))) {
    return false
  }
  const merged = [...others, ...mine].sort(
    (left, right) =>
      ranks.get(workspaceIndexKey(left.workspace))! - ranks.get(workspaceIndexKey(right.workspace))!
  )
  map.set(key, merged)
  return true
}
