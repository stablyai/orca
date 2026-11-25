import { NativeChatVisualOwnerContext } from '../../media/visuals/native-chat-visual-owner'
import {
  nativeChatMarkdownImageSources,
  nativeChatVisualMarkdownImageSources
} from '../../markdown/native-chat-markdown-image-sources'
import { useContext, useLayoutEffect, useMemo, useRef } from 'react'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../../../shared/native-chat/transcript/row-content/native-chat-live-line'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../../../shared/native-chat/transcript/turns/native-chat-live-turn-membership'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import { nativeChatSlotKey } from './native-chat-transcript-slot-selection'
import type { NativeChatSideChatForkPoint } from '../../messages/actions/native-chat-side-chat-fork-point'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'

/** Choose slots/activity together so reasoning shown by the activity line never also gets a transcript row. */
export function useNativeChatTranscriptSlots({
  line,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> & {
  line: {
    /** The row drawn under the transcript, if any. */
    tailRow: 'awaiting-input' | 'activity' | null
    thinking: boolean
    stopping?: boolean
    activityText?: string | null
  }
}): {
  slots: NativeChatTranscriptSlot[]
  forkPoint: NativeChatSideChatForkPoint | null
  liveLine: NativeChatLiveLine | null
} {
  const visualOwner = useContext(NativeChatVisualOwnerContext)
  const imageSources = visualOwner
    ? nativeChatVisualMarkdownImageSources
    : nativeChatMarkdownImageSources
  const {
    messages,
    unresolvedRowIds,
    typography,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    openedPullRequests,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking,
    subagentHeads,
    forkOffer
  } = input
  const { tailRow, thinking, stopping = false, activityText } = line
  const draws = tailRow === 'activity'
  const liveLine = useMemo(
    () =>
      nativeChatLiveLine({
        draws,
        thinking,
        stopping,
        activityText,
        messages,
        inLiveWorkingTurn: (index) =>
          isNativeChatRowInLiveWorkingTurn(
            turnKeys[index],
            liveTurnKey,
            isWorking || lifecycleWorking,
            unresolvedRowIds?.has(messages[index]!.id)
          )
      }),
    [
      activityText,
      draws,
      isWorking,
      lifecycleWorking,
      liveTurnKey,
      messages,
      stopping,
      thinking,
      turnKeys,
      unresolvedRowIds
    ]
  )
  const liveReasoningId = liveLine?.reasoning?.message.id ?? null
  const previousSlots = useRef<readonly NativeChatTranscriptSlot[]>([])
  const { slots: builtSlots, forkPoint } = useMemo(
    () =>
      buildNativeChatTranscript({
        imageSources,
        messages,
        unresolvedRowIds,
        typography,
        turnKeys,
        liveTurnKey,
        receipts,
        turnStatuses,
        turnDiffs,
        openedPullRequests,
        expandedTurnKeys,
        isWorking,
        lifecycleWorking,
        subagentHeads,
        liveReasoningId,
        forkOffer
      }),
    [
      expandedTurnKeys,
      imageSources,
      forkOffer,
      isWorking,
      lifecycleWorking,
      liveReasoningId,
      liveTurnKey,
      messages,
      openedPullRequests,
      receipts,
      subagentHeads,
      turnDiffs,
      turnKeys,
      turnStatuses,
      typography,
      unresolvedRowIds
    ]
  )
  const slots = useMemo(() => {
    const previousOwner = new Map<string, string>()
    for (const slot of previousSlots.current) {
      if (slot.kind === 'message') {
        for (const member of slot.workRun ?? [slot.message]) {
          previousOwner.set(member.id, nativeChatSlotKey(slot))
        }
      }
    }
    const claimed = new Set<string>()
    return builtSlots.map((slot) => {
      if (slot.kind !== 'message') {
        return slot
      }
      const owner = (slot.workRun ?? [slot.message])
        .map((member) => previousOwner.get(member.id))
        .find((key) => key !== undefined && !claimed.has(key))
      const key = owner ?? slot.message.id
      claimed.add(key)
      return key === slot.message.id ? slot : { ...slot, presentationKey: key }
    })
  }, [builtSlots])
  useLayoutEffect(() => {
    previousSlots.current = slots
  }, [slots])
  return { slots, forkPoint, liveLine }
}
