import type { NativeChatSubagentActivity } from '../../../../src/shared/native-chat/input/native-chat-activity'
import { readNativeChatSubagentActivities } from '../../../../src/shared/native-chat/input/native-chat-tool-subagents'

export type MobileNativeChatSubagentSeed = {
  identity: string
  subagents: readonly NativeChatSubagentActivity[] | null
}

/** A task-list frame sets the seed; a replacement window drops it until the next frame restates it. */
export function nextMobileNativeChatSubagentSeed(
  frame: { type?: string; subagents?: unknown },
  identity: string,
  current: MobileNativeChatSubagentSeed | null
): MobileNativeChatSubagentSeed | null {
  if (frame.type === 'task-list') {
    return { identity, subagents: readNativeChatSubagentActivities(frame.subagents) }
  }
  return frame.type === 'replacement' ? null : current
}
