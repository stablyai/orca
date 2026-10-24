import { useEffect, useRef } from 'react'
export function useMobileNativeChatDraftError(
  draftScope: string | null,
  draftError: string | null,
  onSendError: (message: string) => void
): void {
  const shownDraftError = useRef<string | null>(null)
  useEffect(() => {
    if (draftError && shownDraftError.current !== `${draftScope}:${draftError}`) {
      onSendError(draftError)
    }
    shownDraftError.current = draftError ? `${draftScope}:${draftError}` : null
  }, [draftError, draftScope, onSendError])
}
