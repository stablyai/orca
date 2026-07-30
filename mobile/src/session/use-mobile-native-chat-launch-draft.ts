import { useEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizedUserText } from './mobile-native-chat-draft-reconcile'

type DraftUpdater = (
  update: (previous: Record<string, string>) => Record<string, string>
) => void

export function useMobileNativeChatLaunchDraft(args: {
  chatActive: boolean
  draftKey: string | null
  launchDraft?: string | null
  messages: readonly NativeChatMessage[]
  transcriptLoading?: boolean
  updateDrafts: DraftUpdater
}): void {
  const { chatActive, draftKey, launchDraft, messages, transcriptLoading, updateDrafts } = args
  // '' marks a permanent decline so clearing the composer never restores the prefill.
  const seededByKeyRef = useRef(new Map<string, string>())

  useEffect(() => {
    if (
      !draftKey ||
      !chatActive ||
      !launchDraft?.trim() ||
      seededByKeyRef.current.has(draftKey) ||
      transcriptLoading
    ) {
      return
    }
    if (messages.some((message) => normalizedUserText(message) !== null)) {
      seededByKeyRef.current.set(draftKey, '')
      return
    }
    seededByKeyRef.current.set(draftKey, launchDraft)
    updateDrafts((previous) =>
      (previous[draftKey] ?? '') === '' ? { ...previous, [draftKey]: launchDraft } : previous
    )
  }, [chatActive, draftKey, launchDraft, messages, transcriptLoading, updateDrafts])

  useEffect(() => {
    if (!draftKey || !chatActive || transcriptLoading) {
      return
    }
    const seeded = seededByKeyRef.current.get(draftKey)
    if (!seeded) {
      return
    }
    const hasUserTurn = messages.some((message) => normalizedUserText(message) !== null)
    if (!hasUserTurn && launchDraft?.trim()) {
      return
    }
    seededByKeyRef.current.set(draftKey, '')
    updateDrafts((previous) =>
      (previous[draftKey] ?? '') === seeded ? { ...previous, [draftKey]: '' } : previous
    )
  }, [chatActive, draftKey, launchDraft, messages, transcriptLoading, updateDrafts])
}
