import {
  CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
  readReceiverThreadIds
} from '../items/codex-collab-agent-tool-call'
import type { KeptCodexSpawn } from './codex-kept-turn-ordinals'

/** A child as the tracker learns of it from a spawn, so Stop reaches it and its end settles it. */
export function spawnOf(
  parentThreadId: string,
  childThreadId: string,
  label: string | null = null
): KeptCodexSpawn {
  return {
    threadId: parentThreadId,
    turnId: '',
    item: {
      type: CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
      id: `kept-subagent:${childThreadId}`,
      tool: 'spawnAgent',
      status: 'completed',
      // A spawn's prompt is what names its child's row.
      ...(label ? { prompt: label } : {}),
      receiverThreadIds: [childThreadId]
    }
  }
}

/** Parents before their children, so each registers under one already known. */
export function parentsFirst(spawns: KeptCodexSpawn[], primaryThreadId: string): KeptCodexSpawn[] {
  const known = new Set([primaryThreadId])
  const ordered: KeptCodexSpawn[] = []
  let rest = spawns
  while (rest.length > 0) {
    const ready = rest.filter((spawn) => known.has(spawn.threadId))
    const next = ready.length > 0 ? ready : rest
    for (const spawn of next) {
      ordered.push(spawn)
      readReceiverThreadIds(spawn.item).forEach((id) => known.add(id))
    }
    rest = rest.filter((spawn) => !next.includes(spawn))
  }
  return ordered
}
