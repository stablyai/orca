import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { triggerSelection } from '../../../../platform/haptics/haptics'

/**
 * One composer send at a time. `onAccepted` runs only while the send still belongs to what the
 * user is looking at: the same chat, no newer send completion, and no edit to the composer since.
 */
export function useMobileNativeChatComposerSend({
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration
}: {
  sendSurfaceId: string
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
}) {
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  const sendSurfaceIdRef = useRef(sendSurfaceId)
  const sendSurfaceGenerationRef = useRef(0)
  useLayoutEffect(() => {
    if (sendSurfaceIdRef.current !== sendSurfaceId) {
      sendSurfaceIdRef.current = sendSurfaceId
      sendSurfaceGenerationRef.current += 1
    }
  }, [sendSurfaceId])
  const [sending, setSending] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sendSurfaceGenerationRef.current += 1
    }
  }, [])

  const send = async (deliver: () => Promise<boolean>, onAccepted: () => void): Promise<void> => {
    sendingRef.current = true
    setSending(true)
    triggerSelection()
    const sendSurfaceGeneration = sendSurfaceGenerationRef.current
    const sendCompletionGeneration = getSendCompletionGeneration()
    const composerEditGeneration = getComposerEditGeneration()
    try {
      const accepted = await deliver()
      if (
        accepted &&
        mountedRef.current &&
        sendSurfaceGeneration === sendSurfaceGenerationRef.current &&
        sendCompletionGeneration === getSendCompletionGeneration() &&
        composerEditGeneration === getComposerEditGeneration()
      ) {
        onAccepted()
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return { sending, inFlight: () => sendingRef.current, send }
}
