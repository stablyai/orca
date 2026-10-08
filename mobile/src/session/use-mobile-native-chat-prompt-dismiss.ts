import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  mobileNativeChatPromptDismissals as dismissals,
  type MobileNativeChatPromptDismissal
} from './mobile-native-chat-prompt-dismissals'

type DetectedPrompt = { sessionKey: string | null; promptKey: string | null }

/** Presentation only: retain one answered or collapsed occurrence per tab until observations
 *  supersede it. */
export function useMobileNativeChatPromptDismiss({
  kind,
  promptKey,
  detectedPromptKey,
  scopeKey,
  sessionKey,
  observing
}: {
  /** Ask and permission/question cards keep separate answers for the same tab. */
  kind: 'ask' | 'prompt'
  promptKey: string | null
  detectedPromptKey: string | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
}): {
  showPrompt: boolean
  collapsed: boolean
  dismissPrompt: () => void
  collapsePrompt: () => void
  expandPrompt: () => void
} {
  const storeKey = JSON.stringify([kind, scopeKey])
  const detectedByScopeRef = useRef(new Map<string | null, DetectedPrompt>())
  const observation = useMemo(() => {
    const previous = detectedByScopeRef.current.get(scopeKey)
    return previous?.sessionKey === sessionKey && previous.promptKey === detectedPromptKey
      ? previous
      : { sessionKey, promptKey: detectedPromptKey }
  }, [sessionKey, detectedPromptKey, scopeKey])
  const dismissed = useSyncExternalStore(dismissals.subscribe, () => dismissals.read(storeKey))
  useLayoutEffect(() => {
    if (observing) {
      detectedByScopeRef.current.set(scopeKey, observation)
    }
  }, [observing, detectedPromptKey, scopeKey, sessionKey, observation])
  // A cleared or genuinely different detected prompt retires the old dismissal.
  useEffect(() => {
    if (
      observing &&
      dismissed !== undefined &&
      !(dismissed.sessionKey === sessionKey && dismissed.promptKey === detectedPromptKey)
    ) {
      dismissals.forget(storeKey)
    }
  }, [observing, dismissed, detectedPromptKey, storeKey, sessionKey])
  const matches =
    promptKey !== null && dismissed?.sessionKey === sessionKey && dismissed.promptKey === promptKey
  const record = (state: MobileNativeChatPromptDismissal['state']): void => {
    const detected = detectedByScopeRef.current.get(scopeKey)
    if (
      promptKey !== null &&
      detected === observation &&
      detected.sessionKey === sessionKey &&
      detected.promptKey === promptKey
    ) {
      dismissals.write(storeKey, { sessionKey, promptKey, state })
    }
  }

  return {
    showPrompt: promptKey !== null && !matches,
    collapsed: matches && dismissed?.state === 'collapsed',
    dismissPrompt: () => record('answered'),
    collapsePrompt: () => record('collapsed'),
    expandPrompt: () => dismissals.forget(storeKey)
  }
}
