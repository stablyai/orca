import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { InteractivePromptCard } from '../../../../../src/shared/native-chat-interactive-prompt'
import {
  nativeChatCardDismissKey,
  nativeChatPromptDismissalMatches,
  nativeChatPromptOccurrenceKey
} from '../../../../../src/shared/native-chat-prompt-dismiss-key'
import {
  mobileNativeChatPromptDismissals as dismissals,
  type MobileNativeChatPromptDismissal
} from './mobile-native-chat-prompt-dismissals'

type DetectedPrompt = { sessionKey: string | null; occurrenceKey: string | null }

// Keep terminal-card dismissals per tab until observed prompts supersede them.
export function useMobileNativeChatPromptDismiss({
  kind,
  card,
  startedAt,
  scopeKey,
  sessionKey,
  observing
}: {
  /** Ask and permission cards keep separate answers for the same tab. */
  kind: 'ask' | 'prompt'
  card: InteractivePromptCard
  /** The host wait's start for a status-backed card; null for a transcript-only one. */
  startedAt: number | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
}): {
  content: string | null
  occurrenceKey: string | null
  showPrompt: boolean
  collapsed: boolean
  dismissPrompt: () => void
  collapsePrompt: () => void
  expandPrompt: () => void
} {
  const storeKey = JSON.stringify([kind, scopeKey])
  const content = useMemo(() => nativeChatCardDismissKey(card), [card])
  // A question keeps its occurrence across the status-to-transcript handoff; an approval's ends with its wait.
  const occurrenceKey = nativeChatPromptOccurrenceKey(card, content, startedAt)
  const detectedByScopeRef = useRef(new Map<string | null, DetectedPrompt>())
  const observation = useMemo(() => {
    const previous = detectedByScopeRef.current.get(scopeKey)
    return previous?.sessionKey === sessionKey && previous.occurrenceKey === occurrenceKey
      ? previous
      : { sessionKey, occurrenceKey }
  }, [sessionKey, occurrenceKey, scopeKey])
  const dismissed = useSyncExternalStore(dismissals.subscribe, () => dismissals.read(storeKey))
  const matches =
    (!(card?.kind === 'question' && card.prompt.replyAsMessage) ||
      dismissed?.state === 'collapsed') &&
    dismissed?.sessionKey === sessionKey &&
    nativeChatPromptDismissalMatches(dismissed, content, startedAt)
  useLayoutEffect(() => {
    if (observing) {
      detectedByScopeRef.current.set(scopeKey, observation)
    }
  }, [observing, scopeKey, observation])
  useEffect(() => {
    if (observing && dismissed !== undefined && !matches) {
      dismissals.forget(storeKey)
    }
  }, [observing, dismissed, matches, storeKey])
  const record = (state: MobileNativeChatPromptDismissal['state']): void => {
    if (content !== null && detectedByScopeRef.current.get(scopeKey) === observation) {
      dismissals.write(storeKey, { sessionKey, content, startedAt, state })
    }
  }

  return {
    content,
    occurrenceKey,
    showPrompt: content !== null && !matches,
    collapsed: matches && dismissed?.state === 'collapsed',
    dismissPrompt: () => record('answered'),
    collapsePrompt: () => record('collapsed'),
    expandPrompt: () => dismissals.forget(storeKey)
  }
}

/** Keep addressed hides in the existing scoped owner, independently of the loaded definition. */
export function useMobileAsyncQuestionHides(
  scopeKey: string | null,
  sourceKey: string,
  viewKey: string
) {
  const storeKey = JSON.stringify(['async', scopeKey, sourceKey])
  const owner = useMemo(() => ({ storeKey, viewKey }), [storeKey, viewKey])
  const active = useRef<object | null>(null)
  useLayoutEffect(() => {
    active.current = owner
    return () => {
      active.current = null
    }
  }, [owner])
  const hidden = useSyncExternalStore(dismissals.subscribe, () => dismissals.readAsync(storeKey))
  return {
    hidden,
    capture: (ids: readonly string[]) => () => {
      if (active.current === owner) {
        dismissals.hideAsync(storeKey, ids)
      }
    }
  }
}
