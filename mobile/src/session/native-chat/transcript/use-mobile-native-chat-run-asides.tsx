import React, { useMemo } from 'react'
import { INLINE_TEXT_SELECTION } from '../../../platform/text-selection/inline-text-selection'
import type * as Chat from '../../../../../src/shared/native-chat/native-chat-types'
import type { nativeChatWorkRunEntries } from '../../../../../src/shared/native-chat/transcript/folding/native-chat-work-run'
import { nativeChatReasoningDisclosureKey } from '../../../../../src/shared/native-chat/transcript/row-content/native-chat-reasoning-row'
import { MobileNativeChatWorkRunAside } from './messages/MobileNativeChatWorkRunAside'

/** A work run's thoughts, drawn beside the tool calls they came before or after. */
export function useMobileNativeChatRunAsides(
  run: ReturnType<typeof nativeChatWorkRunEntries> | null,
  options: {
    fontScale: number
    live: boolean
    openReasoning: ReadonlySet<string> | undefined
    onToggleReasoning: ((key: string) => void) | undefined
    openSheet: (message: Chat.NativeChatMessage) => void
  }
) {
  const { fontScale, live, openReasoning, onToggleReasoning, openSheet } = options
  return useMemo(() => {
    if (!run) {
      return undefined
    }
    const thought = (thoughtMessage: Chat.NativeChatMessage): React.JSX.Element => (
      // Key by thought so later calls cannot remount it.
      <MobileNativeChatWorkRunAside
        key={`${thoughtMessage.role === 'system' ? 'notice' : 'thought'}:${thoughtMessage.id}`}
        message={thoughtMessage}
        fontScale={fontScale}
        live={live}
        expanded={openReasoning?.has(nativeChatReasoningDisclosureKey(thoughtMessage.id)) === true}
        onToggle={onToggleReasoning}
        onLongPress={INLINE_TEXT_SELECTION ? undefined : () => openSheet(thoughtMessage)}
      />
    )
    const before = new Map<Chat.NativeChatBlock, React.JSX.Element[]>()
    for (const [block, thoughts] of run.asidesBefore) {
      before.set(block, thoughts.map(thought))
    }
    return { before, after: run.asidesAfter.map(thought) }
  }, [run, fontScale, live, openReasoning, onToggleReasoning, openSheet])
}
