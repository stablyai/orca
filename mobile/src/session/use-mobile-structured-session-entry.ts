import * as ExpoCrypto from 'expo-crypto'
import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileStructuredAgent } from './mobile-structured-session-create'
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
  sessionAgent: MobileStructuredAgent | null
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
    sessionAgent,
    creationGuardRef,
    setCreating,
    setCreateError,
    closeDrawer,
    onCreated,
    onError
  } = args
  const [createSupported, setCreateSupported] = useState<Record<MobileStructuredAgent, boolean>>({
    claude: false,
    codex: false
  })
  const session = useMobileStructuredAgentSession({ client, sessionId })
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
    agent: sessionAgent,
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
      setCreateSupported({ claude: false, codex: false })
      return
    }
    setCreateSupported({ claude: false, codex: false })
    let stale = false
    const agents: MobileStructuredAgent[] = ['claude', 'codex']
    void Promise.all(
      agents.map(async (agent) => {
        try {
          const response = await client.sendRequest('agentSession.createSupport', {
            worktree: `id:${worktreeId}`,
            agent
          })
          return [
            agent,
            response.ok && (response.result as { supported?: boolean }).supported === true
          ] as const
        } catch {
          return [agent, false] as const
        }
      })
    ).then((entries) => {
      if (!stale) {
        setCreateSupported(Object.fromEntries(entries) as Record<MobileStructuredAgent, boolean>)
      }
    })
    return () => {
      stale = true
    }
  }, [client, connected, drawerOpen, hostSupported, worktreeId])

  const create = useCallback(
    async (agent: MobileStructuredAgent): Promise<void> => {
      if (!client || creationGuardRef.current || !createSupported[agent]) {
        return
      }
      creationGuardRef.current = true
      setCreating(true)
      setCreateError('')
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
      const createdSessionId = `mobile_${nonce}`
      const worktree = `id:${worktreeId}`
      try {
        const response = await client.sendRequest('agentSession.create', {
          envelope: {
            sessionId: createdSessionId,
            clientOperationId: createStructuredAgentSessionOperationId(() =>
              ExpoCrypto.randomUUID()
            ),
            expectedRuntimeFence: null,
            payloadFingerprint: structuredAgentSessionCreateFingerprint({
              sessionId: createdSessionId,
              worktree,
              agent
            })
          },
          worktree,
          agent
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; refusal?: { message?: string } }
        if (result.ok !== true) {
          throw new Error(result.refusal?.message ?? 'Failed to create chat session')
        }
        closeDrawer()
        onCreated(`agent-session:${createdSessionId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create chat session'
        setCreateError(message)
        onError(message)
      } finally {
        creationGuardRef.current = false
        setCreating(false)
      }
    },
    [
      client,
      closeDrawer,
      createSupported,
      creationGuardRef,
      onCreated,
      onError,
      setCreateError,
      setCreating,
      worktreeId
    ]
  )

  return { createSupported, create, session, writes, sessionOptions, attachments }
}
