import { traexText, type TraexItem } from './traex-protocol'

export function traexChildAnnouncements(item: TraexItem): { id: string; label?: string }[] {
  if (item.type === 'subAgentActivity') {
    const id = traexText(item.agentThreadId)
    const label = traexText(item.agentPath)
      ?.split('/')
      .findLast((part) => part.length > 0)
    return id && label !== 'root' ? [{ id, ...(label ? { label } : {}) }] : []
  }
  if (item.type !== 'collabAgentToolCall' || !Array.isArray(item.receiverThreadIds)) {
    return []
  }
  const label =
    item.tool === 'spawnAgent'
      ? (traexText(item.agentNickname) ?? traexText(item.agentRole) ?? traexText(item.prompt))
      : undefined
  return item.receiverThreadIds.flatMap((id) =>
    typeof id === 'string' ? [{ id, ...(label ? { label } : {}) }] : []
  )
}
