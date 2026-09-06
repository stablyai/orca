import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import type { AiVaultScope } from '../../../../../src/shared/ai-vault-types'
import type {
  MobileWebAgentHistorySession,
  MobileWebAgentHistorySnapshotResult
} from '../../../../../src/shared/mobile-web/agent-history-operation-contract'
import type { MobileWebBridgeClient } from '../../../../../src/mobile-web/src/mobile-web-bridge-client'
import { useMobileWebNativeShell } from '../../../../../src/mobile-web/src/native-shell-channel'
import { useMobileWebRouteParams } from '../../../../src/mobile-web/use-mobile-web-route-params'
import {
  MobileAgentSessionHistoryPresentation,
  type MobileAgentHistoryPresentationState
} from '../../../../src/agent-history/MobileAgentSessionHistoryPresentation'
import { mobileWebAgentHistorySections } from '../../../../src/agent-history/mobile-web-agent-history-sections'
import { buildMobileAgentHistoryResumeActionState } from '../../../../src/agent-history/agent-history-session-card'
import { getWorktreeLabel } from '../../../../src/session/worktree-label'

export default function HostMobileWebAgentHistoryRoute() {
  const shell = useMobileWebNativeShell()
  const router = useRouter()
  const { hostId, worktreeId, name } = useMobileWebRouteParams<{
    hostId: string
    worktreeId: string
    name?: string
  }>()
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<MobileAgentHistoryPresentationState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const sessionsRef = useRef<MobileWebAgentHistorySession[]>([])
  const loadGenerationRef = useRef(0)
  const workspaceName =
    name ??
    (shell.resumeRoute.kind === 'session' && shell.resumeRoute.workspaceId === worktreeId
      ? shell.resumeRoute.workspaceName
      : undefined)

  const load = useCallback(
    async (force: boolean) => {
      const client = shell.client
      const generation = loadGenerationRef.current + 1
      loadGenerationRef.current = generation
      if (!client || shell.connection !== 'connected') {
        setState((current) =>
          current.kind === 'ready' ? current : { kind: 'error', message: 'Waiting for host…' }
        )
        return
      }
      setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))
      try {
        const result = await loadAllPages({
          client,
          workspaceId: worktreeId,
          scope,
          query,
          force
        })
        if (loadGenerationRef.current !== generation) {
          return
        }
        if (!result.supported) {
          sessionsRef.current = []
          setState({ kind: 'unsupported' })
          return
        }
        sessionsRef.current = result.sessions
        setState({
          kind: 'ready',
          sections: mobileWebAgentHistorySections(result.sessions, Date.now()),
          skippedTranscriptCount: result.skippedTranscriptCount
        })
      } catch {
        if (loadGenerationRef.current === generation) {
          setState((current) =>
            current.kind === 'ready'
              ? current
              : { kind: 'error', message: 'Unable to load agent sessions' }
          )
        }
      }
    },
    [query, scope, shell.client, shell.connection, worktreeId]
  )

  useEffect(() => {
    const timeout = setTimeout(() => void load(false), query ? 200 : 0)
    return () => clearTimeout(timeout)
  }, [load, query])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load(true)
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const loadPreview = useCallback(
    async (sessionId: string) => {
      const result = await shell.client?.agentHistory.preview(sessionId)
      return (result?.messages ?? []).map((message) => ({ ...message, timestamp: null }))
    },
    [shell.client]
  )

  const resume = useCallback(
    async (sessionId: string) => {
      if (!shell.client || resumingSessionId) {
        return
      }
      setResumingSessionId(sessionId)
      setResumeMessage(null)
      try {
        const result = await shell.client.agentHistory.resume({
          workspaceId: worktreeId,
          sessionHandle: sessionId
        })
        if (result.status === 'blocked') {
          setResumeMessage(result.message)
          void shell.client.native.hapticFeedback('error')
          return
        }
        setResumeMessage('Agent session queued.')
        void shell.client.native.hapticFeedback('success')
        const params = new URLSearchParams({ name: result.targetWorkspaceName })
        router.push(
          `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(result.targetWorkspaceId)}?${params.toString()}`
        )
      } catch {
        setResumeMessage('Failed to resume session.')
        void shell.client.native.hapticFeedback('error')
      } finally {
        setResumingSessionId(null)
      }
    },
    [hostId, resumingSessionId, router, shell.client, worktreeId]
  )

  const resumeActions = useMemo(
    () =>
      buildMobileAgentHistoryResumeActionState(
        sessionsRef.current.map((session) => ({ id: session.handle })),
        resumingSessionId
      ),
    [resumingSessionId, state]
  )

  return (
    <MobileAgentSessionHistoryPresentation
      worktreeLabel={getWorktreeLabel(workspaceName, worktreeId)}
      scope={scope}
      state={state}
      refreshing={refreshing}
      query={query}
      resumeMessage={resumeMessage}
      resumeActionStateBySessionId={resumeActions}
      onBack={() => router.back()}
      onRefresh={() => void refresh()}
      onRetry={() => void load(false)}
      onSelectScope={setScope}
      onChangeQuery={setQuery}
      loadPreview={loadPreview}
      onResume={resume}
    />
  )
}

async function loadAllPages(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  scope: AiVaultScope
  query: string
  force: boolean
}): Promise<MobileWebAgentHistorySnapshotResult> {
  const sessions: MobileWebAgentHistorySession[] = []
  let cursor: string | undefined
  let skippedTranscriptCount = 0
  do {
    const page = await args.client.agentHistory.snapshot({
      workspaceId: args.workspaceId,
      scope: args.scope,
      query: args.query,
      force: args.force,
      ...(cursor ? { cursor } : {})
    })
    if (!page.supported) {
      return page
    }
    sessions.push(...page.sessions)
    skippedTranscriptCount = page.skippedTranscriptCount
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { supported: true, sessions, skippedTranscriptCount, nextCursor: null }
}
