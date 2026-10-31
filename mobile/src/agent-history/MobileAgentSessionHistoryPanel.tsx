import { loadMobileResumeMetadata } from './mobile-agent-history-resume-metadata'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, CircleAlert, History, RefreshCw, SearchX } from 'lucide-react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSegmentedControl, type MobileSegment } from '../components/MobileSegmentedControl'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { useSessionScreenHandlers } from '../session/session-screen-handlers'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { getWorktreeLabel } from '../session/worktree-label'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  readMobileAiVaultResumeHost,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform,
  resumeAiVaultSessionInTerminal
} from '../session/ai-vault-resume-launch'
import { prepareMobileAiVaultSessionResume } from '../session/ai-vault-resume-preparation'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { AiVaultScope, AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'
import { buildMobileAgentHistorySections } from './agent-history-sections'
import { shouldShowMobileCurrentWorktreeBadge } from './agent-history-current-worktree-badge'
import { MobileAgentSessionHistoryList } from './MobileAgentSessionHistoryList'
import { resolveMobileAiVaultSessionResumeTarget } from './agent-history-resume-target'
import { buildMobileAgentHistoryResumeActionState } from './agent-history-session-card'
import { styles } from './agent-history-styles'
import { AgentHistoryStateView } from './AgentHistoryStateView'
import { AgentHistoryResumeNotice, AgentHistorySkippedNotice } from './AgentHistoryNotices'
import { useNow } from '../hooks/use-now'
import { useMobileResumeOperationOwnership } from './use-mobile-resume-operation-ownership'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  origin?: string
}

function scopeSegments(t: Translate): MobileSegment<AiVaultScope>[] {
  return [
    { value: 'workspace', label: t('agentHistory.panel.workspace', 'Workspace') },
    { value: 'project', label: t('agentHistory.panel.project', 'Project') },
    { value: 'all', label: t('agentHistory.panel.all', 'All') }
  ]
}

export function MobileAgentSessionHistoryPanel(props: MobileAgentSessionHistoryPanelProps) {
  return <MobileAgentSessionHistoryPanelContent key={props.hostId} {...props} />
}

function MobileAgentSessionHistoryPanelContent({
  hostId,
  worktreeId,
  name = '',
  origin = ''
}: MobileAgentSessionHistoryPanelProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Use handoff, not useRouter: resumed session is a native route outside this single-document page.
  const router = useWorkspaceRouteHandoff()
  const sessionBelow = useSessionScreenHandlers(hostId, worktreeId)
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
  const [searchBarHeight, setSearchBarHeight] = useState(0)
  const insets = useSafeAreaInsets()
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const now = useNow(30_000)
  const resumeLaunchInFlightRef = useRef(false)
  const resumeMutationRegistryRef = useRef(
    createMobileAiVaultResumeMutationRegistry(createMobileAiVaultResumeMutationId)
  )
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

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

  // Worktree list seeds host-local scopePaths and current-worktree badge.
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
        // Best-effort context: failed worktree list leaves scoped tabs scanning full history.
      } finally {
        // Mark loaded on failure too so scoped tabs fetch unscoped instead of spinning forever.
        if (!cancelled) {
          setWorktreesLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connState])

  const sessions = screenState.kind === 'ready' ? screenState.sessions : EMPTY_SESSIONS
  const issues = screenState.kind === 'ready' ? screenState.issues : EMPTY_ISSUES
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
        now
      }),
    [sessions, query, scope, scopeFilterPaths, activeWorktreePath, now, t]
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
    () => buildMobileAgentHistoryResumeActionState(sessions, resumingSessionId),
    [resumingSessionId, sessions]
  )

  const onResumeSession = useCallback(
    async (session: AiVaultSession): Promise<void> => {
      if (resumeLaunchInFlightRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        setResumeMessage(t('agentHistory.panel.waitingForHost', 'Waiting for host...'))
        triggerError()
        return
      }
      if (!session.sessionId) {
        setResumeMessage(
          t('agentHistory.panel.missingResumeId', 'This session is missing a resume id.')
        )
        triggerError()
        return
      }

      const assertCurrentOwner = claimResumeOwnership()
      resumeLaunchInFlightRef.current = true
      setResumingSessionId(session.id)
      setResumeMessage(null)
      try {
        const {
          settings,
          worktrees: freshWorktrees,
          ...catalog
        } = await loadMobileResumeMetadata(client)
        assertCurrentOwner()
        const target = resolveMobileAiVaultSessionResumeTarget({
          session,
          activeWorktreeId: worktreeId,
          // Prefer live worktrees so deleted/archived workspace cannot be selected; fall back to mount list only on fetch failure.
          worktrees: freshWorktrees ?? worktrees,
          catalog,
          hostPlatform: resumeHost.platform
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
          setResumeMessage(
            t('agentHistory.panel.unknownHostPlatform', 'Unable to determine host platform.')
          )
          triggerError()
          return
        }

        const preparedSession = await prepareMobileAiVaultSessionResume(client, session)
        assertCurrentOwner()
        const launch = buildMobileAiVaultResumeLaunch({
          session: preparedSession,
          workspacePlatform: platform,
          hostTerminalWindowsShell,
          settings
        })
        const resumed = await resumeAiVaultSessionInTerminal(
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
        setResumeMessage(t('agentHistory.panel.sessionQueued', 'Agent session queued.'))
        // From a session screen the same workspace is the screen below; otherwise the session takes this screen's place.
        if (origin === 'session' && target.worktreeId === worktreeId) {
          sessionBelow?.onResumedTerminal(resumed.terminal)
          router.back()
        } else {
          router.replace(
            `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(target.worktreeId)}`
          )
        }
      } catch (err) {
        triggerError()
        setResumeMessage(
          err instanceof Error
            ? err.message
            : t('agentHistory.panel.resumeFailed', 'Failed to resume session.')
        )
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
      sessionBelow,
      resumeHost,
      hostTerminalWindowsShell,
      router,
      worktreeId,
      worktrees,
      claimResumeOwnership,
      t
    ]
  )

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <NavBar
          leading={
            <NavBarButton
              icon={ChevronLeft}
              onPress={() => router.back()}
              accessibilityLabel={t('common.back', 'Back')}
            />
          }
          title={t('agentHistory.panel.title', 'Agent Session History')}
          subtitle={worktreeLabel}
          trailing={
            <NavBarButton
              icon={RefreshCw}
              onPress={() => void onRefresh()}
              accessibilityLabel={t('agentHistory.panel.refreshSessions', 'Refresh agent sessions')}
            />
          }
          accessory={
            screenState.kind === 'ready' ? (
              <MobileSegmentedControl
                segments={scopeSegments(t)}
                selected={scope}
                onSelect={onSelectScope}
                fill
                style={styles.scopeTabs}
              />
            ) : null
          }
        />
      </SafeAreaView>

      {screenState.kind === 'loading' ? (
        <AgentHistoryStateView
          loading
          title={t('agentHistory.panel.loading', 'Loading agent sessions…')}
        />
      ) : screenState.kind === 'unsupported' ? (
        <AgentHistoryStateView
          icon={History}
          title={t('agentHistory.panel.unavailable', 'Agent Session History Unavailable')}
          message={t(
            'agentHistory.panel.updateHost',
            'Update Orca on this host to browse agent session history.'
          )}
        />
      ) : screenState.kind === 'error' ? (
        <AgentHistoryStateView
          icon={CircleAlert}
          title={t('agentHistory.panel.loadFailed', 'Unable to Load')}
          message={screenState.message}
          action={retry ? { label: t('common.retry', 'Retry'), onPress: retry } : undefined}
        />
      ) : (
        <>
          {issues.length > 0 ? <AgentHistorySkippedNotice issues={issues} /> : null}
          {resumeMessage ? (
            <AgentHistoryResumeNotice
              message={resumeMessage}
              onDismiss={() => setResumeMessage(null)}
            />
          ) : null}
          {sections.length === 0 ? (
            query ? (
              <AgentHistoryStateView
                icon={SearchX}
                title={t('agentHistory.panel.noMatches', 'No matches')}
                message={t('agentHistory.panel.noSearchResults', 'No sessions match your search.')}
                action={{
                  label: t('agentHistory.panel.clearSearch', 'Clear search'),
                  onPress: () => setQuery('')
                }}
                bottomInset={searchBarHeight}
              />
            ) : (
              <AgentHistoryStateView
                icon={History}
                title={t('agentHistory.panel.noSessions', 'No agent sessions')}
                message={t(
                  'agentHistory.panel.emptyScope',
                  'No past agent sessions in this scope.'
                )}
                bottomInset={searchBarHeight}
              />
            )
          ) : (
            <MobileAgentSessionHistoryList
              sections={sections}
              sessionsById={sessionsById}
              refreshing={refreshing}
              showCurrentWorktreeBadges={shouldShowMobileCurrentWorktreeBadge(scope)}
              resumeActionStateBySessionId={resumeActionStateBySessionId}
              onResume={onResumeSession}
              onRefresh={() => void onRefresh()}
              bottomPadding={searchBarHeight}
            />
          )}
          <BottomSearchBar
            value={query}
            onChangeText={setQuery}
            placeholder={t('agentHistory.panel.placeholder', 'Search sessions, repo:, path:')}
            bottomInset={insets.bottom}
            onCoveredHeightChange={setSearchBarHeight}
          />
        </>
      )}
    </View>
  )
}

const EMPTY_SESSIONS: AiVaultSession[] = []
const EMPTY_ISSUES: { agent: AiVaultSession['agent']; path: string; message: string }[] = []

function createMobileAiVaultResumeMutationId(sessionId: string): string {
  const sessionPart = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'session'
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `ai-vault-resume:${sessionPart}:${Date.now().toString(36)}:${randomPart}`
}
