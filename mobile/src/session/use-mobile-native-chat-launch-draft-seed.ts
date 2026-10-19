import { useCallback, useEffect, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizedUserText } from './mobile-native-chat-draft-reconcile'
import { mobileNativeChatLaunchDraftSeeds } from './mobile-native-chat-draft-store'

export type MobileNativeChatLaunchDraftSeed = {
  text: string
  createdAt: number | null
}

/**
 * Adopting the host's launch-context prefill as the mobile composer draft, and
 * retiring it again once it is resolved elsewhere. Split out of the drafts hook
 * so the general draft/pending accounting stays separate from this one concern.
 */
export function useMobileNativeChatLaunchDraftSeed(args: {
  draftKey: string | null
  messages: readonly NativeChatMessage[]
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string | null
  launchDraftCreatedAt?: number | null
  chatActive: boolean
  transcriptLoading?: boolean
  setDraftText: (draftKey: string, update: SetStateAction<string>) => void
}): {
  /** Text still believed to be parked on the agent's TUI input line, or null
   *  once declined or retired. Send paths size their pre-clear from it, since
   *  one Ctrl+U clears only one logical line. */
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

  // Why: launch context delivered as a TUI-input prefill is invisible in chat;
  // adopt it once as the composer draft so mobile shows the same context.
  useEffect(() => {
    if (
      !draftKey ||
      !chatActive ||
      !launchDraft?.trim() ||
      mobileNativeChatLaunchDraftSeeds.has(draftKey)
    ) {
      return
    }
    // Why: `session.tabs` carries launchDraft before the transcript read settles,
    // and an empty (or previous tab's) list would let the decline below misjudge
    // an already-submitted prefill — long enough for a send to duplicate it.
    if (transcriptLoading) {
      return
    }
    // A user turn already in the transcript means the TUI prefill was submitted
    // or deliberately cleared; decline instead of resurrecting it.
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

  // Drop an untouched adopted copy once the prefill is resolved elsewhere — a
  // user turn landed (sent or cleared TUI-side) or the host stopped publishing
  // it (desktop sent or reconciled it). User edits are always kept.
  useEffect(() => {
    // Same gates as the seed: off-chat there is no retraction to read (the tab
    // publishes no draft to us), and an untrusted transcript would wipe an
    // untouched copy on the strength of another tab's user turns.
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

  // A missing or declined entry means there is nothing of ours on the TUI line.
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
