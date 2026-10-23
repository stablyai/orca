import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RouteHandoff } from '../navigation/route-handoff'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { sessionTabsListRead } from '../session/mobile-session-read-operations'
import {
  activateMobileSessionTab,
  cancelLocalSessionTabFollow,
  requestLocalSessionTabFollow
} from '../session/mobile-session-tab-activation'
import { sessionTabClose } from '../session/mobile-session-write-operations'
import type { AiVaultSession, AiVaultSessionOpenTab } from '../../../src/shared/ai-vault-types'
import { openHistorySession } from './worktree-navigation-actions'

type OpenTabClient = Parameters<typeof activateMobileSessionTab>[0] &
  Parameters<typeof sessionTabsListRead.request>[0]

type CandidateWorktree = {
  worktreeId: string
  liveTerminalCount?: number
  hasAttachedPty?: boolean
}

type SnapshotTabCandidate = {
  type?: unknown
  id?: unknown
  parentTabId?: unknown
  leafId?: unknown
  sessionId?: unknown
  agentStatus?: { providerSession?: { id?: unknown } | null } | null
}

function recordOpenTabKey(
  map: Map<string, AiVaultSessionOpenTab>,
  rawId: string,
  target: AiVaultSessionOpenTab
): void {
  if (!rawId) {
    return
  }
  if (!map.has(rawId)) {
    map.set(rawId, target)
  }
  const bare = rawId.includes(':') ? rawId.split(':').at(-1) : undefined
  if (bare && !map.has(bare)) {
    map.set(bare, target)
  }
}

function extractOpenTabsFromSnapshot(
  worktreeId: string,
  rawSnapshot: unknown,
  out: Map<string, AiVaultSessionOpenTab>
): void {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    return
  }
  const tabs = (rawSnapshot as { tabs?: unknown }).tabs
  if (!Array.isArray(tabs)) {
    return
  }
  for (const rawTab of tabs) {
    if (!rawTab || typeof rawTab !== 'object') {
      continue
    }
    const tab = rawTab as SnapshotTabCandidate
    if (typeof tab.id !== 'string' || !tab.id) {
      continue
    }
    if (tab.type === 'agent-session' && typeof tab.sessionId === 'string' && tab.sessionId) {
      recordOpenTabKey(out, tab.sessionId, { worktreeId, tabId: tab.id })
      continue
    }
    if (tab.type === 'terminal') {
      const providerId = tab.agentStatus?.providerSession?.id
      if (typeof providerId !== 'string' || !providerId) {
        continue
      }
      const topTabId =
        typeof tab.parentTabId === 'string' && tab.parentTabId ? tab.parentTabId : tab.id
      const leafId = typeof tab.leafId === 'string' && tab.leafId ? tab.leafId : undefined
      recordOpenTabKey(out, providerId, {
        worktreeId,
        tabId: topTabId,
        ...(leafId ? { leafId } : {})
      })
    }
  }
}

export function useMobileAgentHistoryOpenTabActions(input: {
  client: OpenTabClient | null
  connected: boolean
  hostId: string
  worktreeId: string
  worktrees?: readonly CandidateWorktree[]
  origin?: string
  router: RouteHandoff
  onRefresh: () => void | Promise<void>
  sessions: readonly AiVaultSession[]
  launchInFlightRef: { current: boolean }
  setResumingSessionId: (sessionId: string | null) => void
  setResumeMessage: (message: string | null) => void
}): {
  sessionsWithOpenTabs: readonly AiVaultSession[]
  closingSessionId: string | null
  closedSessionIds: ReadonlySet<string>
  fallbackOpenTabsPending: boolean
  onJumpToOpenSession: (session: AiVaultSession, openTab: AiVaultSessionOpenTab) => Promise<void>
  onCloseOpenSession: (session: AiVaultSession, openTab: AiVaultSessionOpenTab) => Promise<void>
} {
  const {
    client,
    connected,
    hostId,
    worktreeId,
    worktrees,
    origin,
    router,
    onRefresh,
    sessions,
    launchInFlightRef,
    setResumingSessionId,
    setResumeMessage
  } = input
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null)
  const [closedSessionIds, setClosedSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [fallbackOpenTabs, setFallbackOpenTabs] = useState<
    ReadonlyMap<string, AiVaultSessionOpenTab>
  >(() => new Map())
  const [fallbackOpenTabsPending, setFallbackOpenTabsPending] = useState(false)

  // A fresh scan is the host's list again; drop optimistic closes from the previous rows.
  useEffect(() => {
    setClosedSessionIds(new Set())
  }, [sessions])

  // Mixed-version fallback: if the connected host has not stamped `openTab` on
  // `aiVault.listSessions`, probe active worktree tab snapshots via `session.tabs.list`.
  useEffect(() => {
    if (
      !client ||
      !connected ||
      sessions.length === 0 ||
      sessions.some((s) => Boolean(s.openTab))
    ) {
      setFallbackOpenTabs((prev) => (prev.size === 0 ? prev : new Map()))
      setFallbackOpenTabsPending(false)
      return
    }
    const candidateIds = new Set<string>()
    if (worktreeId) {
      candidateIds.add(worktreeId)
    }
    for (const wt of worktrees ?? []) {
      if ((wt.liveTerminalCount ?? 0) > 0 || wt.hasAttachedPty) {
        candidateIds.add(wt.worktreeId)
      }
    }
    if (candidateIds.size === 0) {
      setFallbackOpenTabsPending(false)
      return
    }
    let cancelled = false
    void (async () => {
      const next = new Map<string, AiVaultSessionOpenTab>()
      setFallbackOpenTabsPending(true)
      await Promise.allSettled(
        [...candidateIds].map(async (wtId) => {
          const reply = await sessionTabsListRead.request(client, { worktree: `id:${wtId}` })
          extractOpenTabsFromSnapshot(wtId, sessionTabsListRead.interpret(reply), next)
        })
      )
      if (!cancelled) {
        setFallbackOpenTabs(next)
        setFallbackOpenTabsPending(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connected, sessions, worktreeId, worktrees])

  const sessionsWithOpenTabs = useMemo(() => {
    if (fallbackOpenTabs.size === 0) {
      return sessions
    }
    return sessions.map((session) => {
      if (session.openTab) {
        return session
      }
      const bare = session.sessionId.includes(':')
        ? (session.sessionId.split(':').at(-1) ?? session.sessionId)
        : session.sessionId
      const resolved =
        fallbackOpenTabs.get(session.sessionId) ??
        fallbackOpenTabs.get(bare) ??
        fallbackOpenTabs.get(session.id)
      return resolved ? { ...session, openTab: resolved } : session
    })
  }, [fallbackOpenTabs, sessions])

  const claim = useCallback(
    (sessionId: string, closing: boolean): OpenTabClient | null => {
      if (launchInFlightRef.current) {
        return null
      }
      if (!client || !connected) {
        setResumeMessage('Waiting for host...')
        triggerError()
        return null
      }
      launchInFlightRef.current = true
      if (closing) {
        setClosingSessionId(sessionId)
      } else {
        setResumingSessionId(sessionId)
      }
      setResumeMessage(null)
      return client
    },
    [client, connected, launchInFlightRef, setResumeMessage, setResumingSessionId]
  )

  const finish = useCallback(() => {
    launchInFlightRef.current = false
    setResumingSessionId(null)
    setClosingSessionId(null)
  }, [launchInFlightRef, setResumingSessionId])

  const onJumpToOpenSession = useCallback(
    async (session: AiVaultSession, openTab: AiVaultSessionOpenTab): Promise<void> => {
      const claimed = claim(session.id, false)
      if (!claimed) {
        return
      }
      try {
        requestLocalSessionTabFollow(openTab.worktreeId)
        const response = await activateMobileSessionTab(claimed, {
          worktree: `id:${openTab.worktreeId}`,
          tabId: openTab.tabId,
          ...(openTab.leafId ? { leafId: openTab.leafId } : {}),
          notifyClients: false,
          navigation: 'caller',
          intent: 'user'
        })
        if (!response.ok) {
          cancelLocalSessionTabFollow(openTab.worktreeId)
          triggerError()
          setResumeMessage('Failed to open session tab.')
          return
        }
        triggerSuccess()
        openHistorySession(router, origin, hostId, worktreeId, openTab.worktreeId)
      } catch (err) {
        cancelLocalSessionTabFollow(openTab.worktreeId)
        triggerError()
        setResumeMessage(err instanceof Error ? err.message : 'Failed to open session tab.')
      } finally {
        finish()
      }
    },
    [claim, finish, hostId, origin, router, setResumeMessage, worktreeId]
  )

  const onCloseOpenSession = useCallback(
    async (session: AiVaultSession, openTab: AiVaultSessionOpenTab): Promise<void> => {
      const claimed = claim(session.id, true)
      if (!claimed) {
        return
      }
      try {
        const response = sessionTabClose.interpret(
          await sessionTabClose.request(claimed, {
            worktree: `id:${openTab.worktreeId}`,
            tabId: openTab.tabId,
            reason: 'user'
          })
        )
        if (response.accepted) {
          setClosedSessionIds((prev) => new Set(prev).add(session.id))
          triggerSuccess()
          void onRefresh()
        } else {
          triggerError()
          setResumeMessage('Failed to close session tab.')
        }
      } catch (err) {
        triggerError()
        setResumeMessage(err instanceof Error ? err.message : 'Failed to close session tab.')
      } finally {
        finish()
      }
    },
    [claim, finish, onRefresh, setResumeMessage]
  )

  return {
    sessionsWithOpenTabs,
    closingSessionId,
    closedSessionIds,
    fallbackOpenTabsPending,
    onJumpToOpenSession,
    onCloseOpenSession
  }
}
