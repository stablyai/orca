import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  ImageLibraryPermissionError,
  pickMobileImages,
  type MobileImageSource
} from './mobile-image-source-picker'
import {
  appendPendingNativeChatImages,
  uploadMobileNativeChatImages,
  type PendingNativeChatImage
} from './mobile-native-chat-image-attachment'

export function useMobileStructuredAttachments(args: {
  client: RpcClient | null
  sessionId: string | null
  getConnectionId: () => Promise<string | null>
  onError: (message: string) => void
}): {
  attachments: PendingNativeChatImage[]
  attaching: boolean
  attach: (source: MobileImageSource) => Promise<void>
  remove: (id: string) => void
  clear: () => void
} {
  const [state, setState] = useState<{
    sessionId: string | null
    attachments: PendingNativeChatImage[]
    attaching: boolean
  }>({ sessionId: args.sessionId, attachments: [], attaching: false })
  const sessionRef = useRef(args.sessionId)
  const generationRef = useRef(0)
  const idCounterRef = useRef(0)
  const { client, getConnectionId, onError, sessionId } = args
  useEffect(() => {
    sessionRef.current = sessionId
    generationRef.current += 1
  }, [sessionId])
  const attachments = state.sessionId === sessionId ? state.attachments : []
  const attaching = state.sessionId === sessionId && state.attaching

  const attach = useCallback(
    async (source: MobileImageSource): Promise<void> => {
      if (!client || !sessionId || attaching) {
        return
      }
      const targetSession = sessionId
      const targetGeneration = generationRef.current
      try {
        await uploadMobileNativeChatImages(source, {
          client,
          getConnectionId,
          pickImages: pickMobileImages,
          onUploadStart: () => {
            if (
              generationRef.current === targetGeneration &&
              sessionRef.current === targetSession
            ) {
              setState((current) => ({
                sessionId: targetSession,
                attachments: current.sessionId === targetSession ? current.attachments : [],
                attaching: true
              }))
            }
          },
          onImageUploaded: (uploaded) => {
            if (
              generationRef.current === targetGeneration &&
              sessionRef.current === targetSession
            ) {
              setState((current) => ({
                sessionId: targetSession,
                attachments: appendPendingNativeChatImages(
                  current.sessionId === targetSession ? current.attachments : [],
                  [uploaded],
                  idCounterRef
                ),
                attaching: true
              }))
            }
          }
        })
      } catch (error) {
        if (generationRef.current === targetGeneration && sessionRef.current === targetSession) {
          onError(
            error instanceof ImageLibraryPermissionError
              ? 'Photo permission denied'
              : error instanceof Error && error.message === 'Clipboard image is too large'
                ? 'Image too large to attach'
                : 'Attach failed'
          )
        }
      } finally {
        if (generationRef.current === targetGeneration && sessionRef.current === targetSession) {
          setState((current) => ({
            sessionId: targetSession,
            attachments: current.sessionId === targetSession ? current.attachments : [],
            attaching: false
          }))
        }
      }
    },
    [attaching, client, getConnectionId, onError, sessionId]
  )

  return {
    attachments,
    attaching,
    attach,
    remove: (id) =>
      setState((current) => ({
        sessionId,
        attachments:
          current.sessionId === sessionId
            ? current.attachments.filter((entry) => entry.id !== id)
            : [],
        attaching: current.sessionId === sessionId && current.attaching
      })),
    clear: () => {
      generationRef.current += 1
      setState({ sessionId, attachments: [], attaching: false })
    }
  }
}
