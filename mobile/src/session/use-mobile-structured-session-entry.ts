import * as ExpoCrypto from 'expo-crypto'
import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileStructuredAttachments } from './use-mobile-structured-attachments'
import { useMobileStructuredSessionOptions } from './use-mobile-structured-session-options'
import { useMobileStructuredSessionWrites } from './use-mobile-structured-session-writes'

export function useMobileStructuredSessionEntry(args: {
  client: RpcClient | null
  connected: boolean
  drawerOpen: boolean
  hostSupported: boolean
  worktreeId: string
  sessionId: string | null
  creationGuardRef: MutableRefObject<boolean>
  setCreating: (creating: boolean) => void
  setCreateError: (message: string) => void
  closeDrawer: () => void
  onCreated: (tabId: string) => void
  onError: (message: string) => void
  getConnectionId: () => Promise<string | null>
}) {
  const {
    client,
    connected,
    drawerOpen,
    hostSupported,
    worktreeId,
    sessionId,
    creationGuardRef,
    setCreating,
    setCreateError,
    closeDrawer,
    onCreated,
    onError
  } = args
  const [createSupported, setCreateSupported] = useState(false)
  const session = useMobileStructuredAgentSession({
    client,
    sessionId
  })
  const writes = useMobileStructuredSessionWrites({
    client,
    connected,
    sessionId,
    fence: session.fence,
    submissions: session.submissions,
    handoffOperationId: session.handoff?.operationId
  })
  const sessionOptions = useMobileStructuredSessionOptions({
    client,
    connected,
    sessionId,
    fence: session.fence,
    setOption: writes.setOption
  })
  const attachments = useMobileStructuredAttachments({
    client,
    sessionId,
    getConnectionId: args.getConnectionId,
    onError
  })

  useEffect(() => {
    if (!client || !connected || !drawerOpen || !hostSupported) {
      setCreateSupported(false)
      return
    }
    setCreateSupported(false)
    let stale = false
    void client
      .sendRequest('agentSession.createSupport', {
        worktree: `id:${worktreeId}`,
        agent: 'codex'
      })
      .then((response) => {
        if (!stale) {
          setCreateSupported(
            response.ok && (response.result as { supported?: boolean }).supported === true
          )
        }
      })
      .catch(() => !stale && setCreateSupported(false))
    return () => {
      stale = true
    }
  }, [client, connected, drawerOpen, hostSupported, worktreeId])

  const create = useCallback(async (): Promise<void> => {
    if (!client || creationGuardRef.current || !createSupported) {
      return
    }
    creationGuardRef.current = true
    setCreating(true)
    setCreateError('')
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
    const sessionId = `mobile_${nonce}`
    const worktree = `id:${worktreeId}`
    try {
      const response = await client.sendRequest('agentSession.create', {
        envelope: {
          sessionId,
          clientOperationId: createStructuredAgentSessionOperationId(() => ExpoCrypto.randomUUID()),
          expectedRuntimeFence: null,
          payloadFingerprint: structuredAgentSessionCreateFingerprint({ sessionId, worktree })
        },
        worktree,
        agent: 'codex'
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = response.result as { ok?: boolean; refusal?: { message?: string } }
      if (result.ok !== true) {
        throw new Error(result.refusal?.message ?? 'Failed to create chat session')
      }
      closeDrawer()
      onCreated(`agent-session:${sessionId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create chat session'
      setCreateError(message)
      onError(message)
    } finally {
      creationGuardRef.current = false
      setCreating(false)
    }
  }, [
    client,
    closeDrawer,
    createSupported,
    creationGuardRef,
    onCreated,
    onError,
    setCreateError,
    setCreating,
    worktreeId
  ])

  return { createSupported, create, session, writes, sessionOptions, attachments }
}
