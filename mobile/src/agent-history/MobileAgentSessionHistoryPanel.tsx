import { loadMobileResumeMetadata } from './mobile-agent-history-resume-metadata'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { getWorktreeLabel } from '../session/worktree-label'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationId,
  createMobileAiVaultResumeMutationRegistry,
  readMobileAiVaultResumeHost,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform,
  resumeAiVaultSessionInTerminal
} from '../session/ai-vault-resume-launch'
import { prepareMobileAiVaultSessionResume } from '../session/ai-vault-resume-preparation'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { MOBILE_AGENT_HISTORY_SCOPE_TABS } from './agent-history-scope-paths'
import type { Worktree } from '../worktree/workspace-list-types'
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'
import { buildMobileAgentHistorySections } from './agent-history-sections'
import { shouldShowMobileCurrentWorktreeBadge } from './agent-history-current-worktree-badge'
import {
  MobileAgentSessionHistoryList,
  useMobileAgentHistoryOpenTabActions
} from './MobileAgentSessionHistoryList'
import { openHistorySession } from './worktree-navigation-actions'
import { resolveMobileAiVaultSessionResumeTarget } from './agent-history-resume-target'
import { buildMobileAgentHistoryResumeActionState } from './agent-history-session-card'
import { styles } from './agent-history-styles'
import { useNow } from '../hooks/use-now'
import { useMobileResumeOperationOwnership } from './use-mobile-resume-operation-ownership'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  origin?: string
}

export function MobileAgentSessionHistoryPanel(props: MobileAgentSessionHistoryPanelProps) {
  return <MobileAgentSessionHistoryPanelContent key={props.hostId} {...props} />
}

function MobileAgentSessionHistoryPanelContent({
  hostId,
  worktreeId,
  name = '',
  origin
}: MobileAgentSessionHistoryPanelProps) {
  // Not `useRouter`: inside the shell's page this screen is one document standing in for one
  // screen, and the session it resumes into is a native route the shell has to open.
  const router = useWorkspaceRouteHandoff()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const claimResumeOwnership = useMobileResumeOperationOwnership(
    hostId,
    worktreeId,
    client,
    connState
  )
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [worktreesLoaded, setWorktreesLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const now = useNow(30_000)
  const resumeLaunchInFlightRef = useRef(false)
  const resumeMutationRegistryRef = useRef(
    createMobileAiVaultResumeMutationRegistry(createMobileAiVaultResumeMutationId)
  )
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  // Why: the worktree list seeds the host-local scopePaths derivation and the
  // active-worktree path for the "current worktree" badge.
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const worktreeReply = await worktreeCatalogRead.request(client, { limit: 10000 })
        if (cancelled) {
          return
        }
        const catalog = worktreeCatalogRead.interpret(worktreeReply)
        if (catalog.accepted) {
          // Why `?? []`: the member is salvaged, so an envelope the host answers without rows leaves it
          // absent, and `use-mobile-agent-history-state.ts:61` calls `.find` on it unguarded.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows stay opaque in the reader because three screens project them differently; this panel reads only `path` off a row to seed `scopePaths`, and `matrix-aivault.history-screen-worktree.ps-1` records every partition of its own family rendering a list rather than a crash.
          setWorktrees((catalog.value.worktrees ?? []) as Worktree[])
        }
      } catch {
        // Why: worktree list is best-effort context; the session scan still runs
        // (without it, scoped tabs can't narrow and fall back to the full list).
      } finally {
        // Why: mark loaded even on failure so a scoped tab proceeds with an
        // unscoped fetch instead of holding a spinner forever.
        if (!cancelled) {
          setWorktreesLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connState])

  const {
    scope,
    screenState,
    refreshing,
    hostStatusResult,
    activeWorktreePath,
    scopeFilterPaths,
    onSelectScope,
    onRefresh,
    retry
  } = useMobileAgentHistoryState({ hostId, worktreeId, worktrees, worktreesLoaded })

  const issues = screenState.kind === 'ready' ? screenState.issues : EMPTY_ISSUES
  const openTabActions = useMobileAgentHistoryOpenTabActions({
    client,
    connected: connState === 'connected',
    hostId,
    worktreeId,
    worktrees,
    origin,
    router,
    onRefresh,
    sessions: screenState.kind === 'ready' ? screenState.sessions : EMPTY_SESSIONS,
    launchInFlightRef: resumeLaunchInFlightRef,
    setResumingSessionId,
    setResumeMessage
  })
  const sessions = openTabActions.sessionsWithOpenTabs
  const { closingSessionId, closedSessionIds, fallbackOpenTabsPending, onJumpToOpenSession } =
    openTabActions
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  )
  const sections = useMemo(
    () =>
      buildMobileAgentHistorySections(sessions, {
        query,
        scope,
        scopeFilterPaths,
        activeWorktreePath,
        now,
        closedSessionIds
      }),
    [sessions, query, scope, scopeFilterPaths, activeWorktreePath, now, closedSessionIds]
  )

  const resumeHost = useMemo(
    () => readMobileAiVaultResumeHost(hostStatusResult),
    [hostStatusResult]
  )
  const hostTerminalWindowsShell = useMemo(
    () => readMobileRuntimeTerminalWindowsShell(hostStatusResult),
    [hostStatusResult]
  )

  const resumeActionStateBySessionId = useMemo(
    () =>
      buildMobileAgentHistoryResumeActionState(
        sessions,
        resumingSessionId,
        closingSessionId,
        fallbackOpenTabsPending
      ),
    [closingSessionId, fallbackOpenTabsPending, resumingSessionId, sessions]
  )

  const onResumeSession = useCallback(
    async (session: AiVaultSession): Promise<void> => {
      if (resumeLaunchInFlightRef.current) {
        return
      }
      // The tab is already open; focusing it must not spawn a second terminal.
      if (session.openTab && !closedSessionIds.has(session.id)) {
        await onJumpToOpenSession(session, session.openTab)
        return
      }
      if (!client || connState !== 'connected') {
        setResumeMessage('Waiting for host...')
        triggerError()
        return
      }
      if (!session.sessionId) {
        setResumeMessage('This session is missing a resume id.')
        triggerError()
        return
      }

      const assertCurrentOwner = claimResumeOwnership()
      resumeLaunchInFlightRef.current = true
      setResumingSessionId(session.id)
      setResumeMessage(null)
      try {
        const {
          repos,
          folderWorkspaces,
          projectGroups,
          settings,
          worktrees: freshWorktrees
        } = await loadMobileResumeMetadata(client)
        assertCurrentOwner()
        const resumeWorktrees = freshWorktrees ?? worktrees
        const target = resolveMobileAiVaultSessionResumeTarget({
          session,
          activeWorktreeId: worktreeId,
          // Why: resolve against live worktrees so a workspace deleted or
          // archived since panel mount can't be picked; the mount-time list is
          // only a fallback when the fresh fetch fails.
          worktrees: resumeWorktrees,
          repos,
          folderWorkspaces,
          projectGroups
        })
        if (target.status !== 'ready') {
          setResumeMessage(target.message)
          triggerError()
          return
        }

        const platform = resolveMobileAiVaultResumePlatform(
          target.targetStatus,
          resumeHost.platform,
          target.workspacePath,
          target.terminalPlatform
        )
        if (!platform) {
          setResumeMessage('Unable to determine host platform.')
          triggerError()
          return
        }

        const preparedSession = await prepareMobileAiVaultSessionResume(client, session)
        assertCurrentOwner()
        const launch = buildMobileAiVaultResumeLaunch({
          session: preparedSession,
          hostPlatform: platform,
          hostTerminalWindowsShell,
          settings
        })
        await resumeAiVaultSessionInTerminal(
          client,
          target.worktreeId,
          {
            ...launch,
            hostCapabilities: resumeHost.capabilities,
            clientMutationId: resumeMutationRegistryRef.current.claim(session.id)
          },
          assertCurrentOwner
        )
        resumeMutationRegistryRef.current.releaseOnSuccess(session.id)
        triggerSuccess()
        // The host accepted the resume; a cutover now only stops navigation.
        try {
          assertCurrentOwner()
        } catch {
          return
        }
        setResumeMessage('Agent session queued.')
        const resumedName = getWorktreeLabel(
          resumeWorktrees.find((item) => item.worktreeId === target.worktreeId)?.displayName,
          target.worktreeId
        )
        openHistorySession(router, origin, hostId, worktreeId, target.worktreeId, resumedName)
      } catch (err) {
        triggerError()
        setResumeMessage(err instanceof Error ? err.message : 'Failed to resume session.')
      } finally {
        resumeLaunchInFlightRef.current = false
        setResumingSessionId(null)
      }
    },
    [
      client,
      connState,
      hostId,
      origin,
      resumeHost,
      hostTerminalWindowsShell,
      router,
      worktreeId,
      worktrees,
      claimResumeOwnership,
      closedSessionIds,
      onJumpToOpenSession
    ]
  )

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              Agent Session History
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {worktreeLabel}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}
            onPress={() => void onRefresh()}
            hitSlop={8}
            accessibilityLabel="Refresh agent sessions"
          >
            <RefreshCw size={18} color={colors.textSecondary} strokeWidth={2.1} />
          </Pressable>
        </View>
      </SafeAreaView>

      {screenState.kind === 'loading' ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : screenState.kind === 'unsupported' ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>Agent Session History Unavailable</Text>
          <Text style={styles.stateText}>
            Update Orca on this host to browse agent session history.
          </Text>
        </View>
      ) : screenState.kind === 'error' ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>Unable to Load</Text>
          <Text style={styles.stateText}>{screenState.message}</Text>
          {retry ? (
            <Pressable style={styles.retryButton} onPress={retry}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.scopeTabs}>
            {MOBILE_AGENT_HISTORY_SCOPE_TABS.map((tab) => {
              const active = scope === tab.scope
              return (
                <Pressable
                  key={tab.scope}
                  style={[styles.scopeTab, active && styles.scopeTabActive]}
                  onPress={() => onSelectScope(tab.scope)}
                >
                  <Text style={[styles.scopeTabText, active && styles.scopeTabTextActive]}>
                    {tab.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search sessions, repo:, path:"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {issues.length > 0 ? (
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeText}>
                {issues.length} {issues.length === 1 ? 'transcript' : 'transcripts'} skipped
              </Text>
            </View>
          ) : null}
          {resumeMessage ? (
            <View style={styles.resumeBanner}>
              <Text style={styles.resumeBannerText}>{resumeMessage}</Text>
            </View>
          ) : null}
          {sections.length === 0 ? (
            <View style={styles.state}>
              <Text style={styles.stateTitle}>No agent sessions</Text>
              <Text style={styles.stateText}>
                {query ? 'No sessions match your search.' : 'No past agent sessions in this scope.'}
              </Text>
            </View>
          ) : (
            <MobileAgentSessionHistoryList
              sections={sections}
              sessionsById={sessionsById}
              refreshing={refreshing}
              showCurrentWorktreeBadges={shouldShowMobileCurrentWorktreeBadge(scope)}
              resumeActionStateBySessionId={resumeActionStateBySessionId}
              onResume={onResumeSession}
              onJumpToOpenTab={onJumpToOpenSession}
              onCloseOpenTab={openTabActions.onCloseOpenSession}
              onRefresh={() => void onRefresh()}
            />
          )}
        </>
      )}
    </View>
  )
}

const EMPTY_SESSIONS: AiVaultSession[] = []
const EMPTY_ISSUES: { agent: AiVaultSession['agent']; path: string; message: string }[] = []
