import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../src/shared/agent-session-failure'
import { sameAgentSessionFailureFact } from '../../../src/shared/agent-session-visible-failures'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { structuredAgentSessionRejectionNotice } from '../../../src/shared/structured-agent-session-rejection-words'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import type { StructuredAgentSessionCommandRefusalCause } from '../../../src/shared/structured-agent-session-composer'

/** What a send error says beyond its text. `refusedWhile`: a refused command's cause, whose line is
 *  said only while the chat shows it. `failure`: a rejected send's fact, whose guidance steps aside
 *  once the transcript states the same failure. */
export type MobileNativeChatSendErrorDetails = {
  refusedWhile?: StructuredAgentSessionCommandRefusalCause
  failure?: AgentSessionFailureFact
}

export type MobileNativeChatSendErrorReporter = (
  message: string,
  details?: MobileNativeChatSendErrorDetails
) => void

/** What the phone's chat shows a refused command waiting on. */
export type MobileNativeChatCommandRefusalCauses = Readonly<
  Partial<Record<StructuredAgentSessionCommandRefusalCause, boolean>>
>

const NATIVE_CHAT_SEND_ERROR_HOLD_MS = 4000
const NATIVE_CHAT_SEND_ERROR_TOAST_MS = 1600

/** A held rejection keeps its guidance until the current transcript states the same failure. */
export function mobileNativeChatSendErrorMessage(
  error: { message: string | null; failure?: AgentSessionFailureFact },
  messages: readonly NativeChatMessage[]
): string | null {
  const { failure, message } = error
  if (!message || !failure) {
    return message
  }
  const stated = foldMobileNativeChatMessages(messages).some((row) =>
    row.blocks.some((block) => {
      const fact =
        block.type === 'text' ? readWholeAgentSessionFailureFact(block.failure) : undefined
      return fact !== undefined && sameAgentSessionFailureFact(failure, fact)
    })
  )
  return stated ? structuredAgentSessionRejectionNotice(null, 'composer-send') : message
}

/** Holds the newest native-chat send failure for the composer's inline banner.
 *  Why a banner and not the bottom toast: chat failures happen with the keyboard
 *  up, which covers the toast — the surface the user is looking at is the composer.
 *  Scoped like drafts and image chips: a failure belongs to the terminal it was
 *  raised on and must not follow the user to another tab. */
export function useMobileNativeChatSendError(args: {
  scopeKey: string | null
  showToast: (message: string, durationMs?: number) => void
}): {
  message: string | null
  failure?: AgentSessionFailureFact
  show: MobileNativeChatSendErrorReporter
  clear: () => void
  /** Called each render with what the chat shows: a refusal whose cause has ended is dropped. */
  keepWhile: (causes: MobileNativeChatCommandRefusalCauses | null) => void
  /** Set by the route each render; gates banner vs toast. */
  bannerMountedRef: MutableRefObject<boolean>
} {
  const [error, setError] = useState<
    ({ scopeKey: string | null; message: string } & MobileNativeChatSendErrorDetails) | null
  >(null)
  if (error && error.scopeKey !== args.scopeKey) {
    setError(null)
  }
  const visibleError = error?.scopeKey === args.scopeKey ? error : null
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerMountedRef = useRef(false)
  const showToastRef = useRef(args.showToast)
  showToastRef.current = args.showToast
  // Why: `show`/`clear` are handed to sends that resolve much later (a 20s
  // unconfirmed send, a paced answer). Comparing the scope they were built for
  // against the live one is what stops tab A's late outcome from painting — or
  // wiping — tab B's banner.
  const liveScopeRef = useRef(args.scopeKey)
  liveScopeRef.current = args.scopeKey
  const scopeKey = args.scopeKey
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])
  const clear = useCallback(() => {
    if (liveScopeRef.current !== scopeKey) {
      return
    }
    clearTimer()
    setError(null)
  }, [clearTimer, scopeKey])
  const show = useCallback(
    (next: string, details?: MobileNativeChatSendErrorDetails) => {
      // Why: deferred failures can land after the user left chat (banner unmounted)
      // or moved to another tab, where the banner belongs to a different terminal —
      // both must fall back to the toast instead of being swallowed or misattributed.
      if (liveScopeRef.current !== scopeKey || !bannerMountedRef.current) {
        showToastRef.current(next, NATIVE_CHAT_SEND_ERROR_TOAST_MS)
        return
      }
      clearTimer()
      setError({ scopeKey, message: next, ...details })
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setError(null)
      }, NATIVE_CHAT_SEND_ERROR_HOLD_MS)
    },
    [clearTimer, scopeKey]
  )
  // A scope change retires its timer; rendering already discards its held failure.
  useEffect(() => {
    clearTimer()
  }, [clearTimer, scopeKey])
  useEffect(
    () => () => {
      // Why: the route writes this ref during render, so an unmount leaves it stuck
      // true and a pending send's late failure would target a banner that no longer
      // exists — swallowing the one signal the toast fallback is here to carry.
      bannerMountedRef.current = false
      clearTimer()
    },
    [clearTimer]
  )
  const keepWhile = (causes: MobileNativeChatCommandRefusalCauses | null) => {
    // Dropped, not hidden: the cause coming back later is not what this refusal was about.
    const refusedWhile = visibleError?.refusedWhile
    if (refusedWhile !== undefined && causes?.[refusedWhile] === false) {
      setError(null)
    }
  }
  return {
    message: visibleError?.message ?? null,
    ...(visibleError?.failure ? { failure: visibleError.failure } : {}),
    show,
    clear,
    keepWhile,
    bannerMountedRef
  }
}
