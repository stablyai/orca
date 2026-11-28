import {
  readNativeChatTaskSeedList,
  type NativeChatTaskSeedList
} from '../../../../src/shared/native-chat/input/native-chat-claude-task-updates'

export type MobileNativeChatTaskSeed = { identity: string; taskList: NativeChatTaskSeedList | null }

/** A task-list frame sets the seed; a replacement window drops it until the next frame restates it. */
export function nextMobileNativeChatTaskSeed(
  frame: { type?: string; taskList?: unknown },
  identity: string,
  current: MobileNativeChatTaskSeed | null
): MobileNativeChatTaskSeed | null {
  if (frame.type === 'task-list') {
    return { identity, taskList: readNativeChatTaskSeedList(frame.taskList) }
  }
  return frame.type === 'replacement' ? null : current
}
