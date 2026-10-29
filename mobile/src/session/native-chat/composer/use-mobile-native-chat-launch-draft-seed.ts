import { useCallback, useEffect, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import {
  launchDraftResolvedByTranscript,
  nativeChatLaunchDraftTurnBaseline,
  type NativeChatLaunchDraftTurnBaseline
} from '../../../../../src/shared/native-chat-launch-draft-resolution'
import { normalizedUserText } from './mobile-native-chat-draft-reconcile'
import { mobileNativeChatLaunchDraftSeeds } from './mobile-native-chat-draft-store'

export type MobileNativeChatLaunchDraftSeed = {
  text: string
  createdAt: number | null
  baseline?: NativeChatLaunchDraftTurnBaseline
}

function launchDraftResolved(
  createdAt: number | null,
  messages: readonly NativeChatMessage[],
  baseline?: NativeChatLaunchDraftTurnBaseline
): boolean {
  // Old hosts send no creation time, so any user turn retires the draft.
  if (createdAt === null) {
    return messages.some((message) => normalizedUserText(message) !== null)
  }
  return launchDraftResolvedByTranscript({ createdAt }, messages, baseline)
}

export function useMobileNativeChatLaunchDraftSeed(args: {
  draftKey: string | null
  messages: readonly NativeChatMessage[]
  launchDraft?: string | null
  launchDraftCreatedAt?: number | null
  chatActive: boolean
  transcriptLoading?: boolean
  setDraftText: (draftKey: string, update: SetStateAction<string>) => void
}): {
  // Retain unresolved parked TUI text for pre-clear sizing; Ctrl+U clears only one logical line.
  readSeededLaunchDraft: () => string | null
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
} {
  const {
    draftKey,
    messages,
    launchDraft,
    launchDraftCreatedAt,
    chatActive,
    transcriptLoading,
    setDraftText
  } = args

  useEffect(() => {
    if (
      !draftKey ||
      !chatActive ||
      !launchDraft?.trim() ||
      mobileNativeChatLaunchDraftSeeds.has(draftKey)
    ) {
      return
    }
    // Wait for own settled history: early/previous-tab rows can misjudge an already-submitted prefill and cause duplicate sends.
    if (transcriptLoading) {
      return
    }
    const createdAt = launchDraftCreatedAt ?? null
    if (launchDraftResolved(createdAt, messages)) {
      mobileNativeChatLaunchDraftSeeds.set(draftKey, null)
      return
    }
    mobileNativeChatLaunchDraftSeeds.set(draftKey, {
      text: launchDraft,
      createdAt,
      baseline: nativeChatLaunchDraftTurnBaseline(messages)
    })
    setDraftText(draftKey, (current) => (current === '' ? launchDraft : current))
  }, [
    chatActive,
    draftKey,
    launchDraft,
    launchDraftCreatedAt,
    messages,
    setDraftText,
    transcriptLoading
  ])

  // Retire only untouched adopted text when the host resolves prefill; user edits always survive.
  useEffect(() => {
    // Off-chat omissions are not retractions, and another tab’s history must not retire this seed.
    if (!draftKey || !chatActive || transcriptLoading) {
      return
    }
    const seeded = mobileNativeChatLaunchDraftSeeds.get(draftKey)
    if (!seeded) {
      return
    }
    if (!launchDraftResolved(seeded.createdAt, messages, seeded.baseline) && launchDraft?.trim()) {
      return
    }
    mobileNativeChatLaunchDraftSeeds.set(draftKey, null)
    setDraftText(draftKey, (current) => (current === seeded.text ? '' : current))
  }, [chatActive, draftKey, launchDraft, messages, setDraftText, transcriptLoading])

  const readSeededLaunchDraft = useCallback(
    () => (draftKey ? (mobileNativeChatLaunchDraftSeeds.get(draftKey)?.text ?? null) : null),
    [draftKey]
  )
  const readSeededLaunchDraftSeed = useCallback(
    () => (draftKey ? (mobileNativeChatLaunchDraftSeeds.get(draftKey) ?? null) : null),
    [draftKey]
  )

  return { readSeededLaunchDraft, readSeededLaunchDraftSeed }
}
