import { useCallback, useEffect, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizedUserText } from './mobile-native-chat-draft-reconcile'
import { mobileNativeChatLaunchDraftSeeds } from './mobile-native-chat-draft-store'

export type MobileNativeChatLaunchDraftSeed = {
  text: string
  createdAt: number | null
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
    if (messages.some((message) => normalizedUserText(message) !== null)) {
      mobileNativeChatLaunchDraftSeeds.set(draftKey, null)
      return
    }
    mobileNativeChatLaunchDraftSeeds.set(draftKey, {
      text: launchDraft,
      createdAt: launchDraftCreatedAt ?? null
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
    const hasUserTurn = messages.some((message) => normalizedUserText(message) !== null)
    if (!hasUserTurn && launchDraft?.trim()) {
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
