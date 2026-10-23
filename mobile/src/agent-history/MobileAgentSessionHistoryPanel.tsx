import { loadMobileResumeMetadata } from './mobile-agent-history-resume-metadata'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { CircleAlert, CloudOff, History, SearchX } from 'lucide-react-native'
import { MobileSegmentedControl, type MobileSegment } from '../components/MobileSegmentedControl'
import { MobileSearchField } from '../components/MobileSearchField'
import { MobileNavRefreshButton } from '../components/MobileNavRefreshButton'
import { NavBar } from '../components/ui/NavBar'
import { Banner } from '../components/ui/Banner'
import { Collapsible } from '../components/ui/Collapsible'
import { StateView } from '../components/ui/StateView'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
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
import { useNow } from '../hooks/use-now'
import { useMobileResumeOperationOwnership } from './use-mobile-resume-operation-ownership'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
}

const SCOPE_SEGMENTS: readonly MobileSegment<AiVaultScope>[] = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'project', label: 'Project' },
  { value: 'all', label: 'All' }
]

type ResumeNotice = { tone: 'info' | 'error'; text: string }

export function MobileAgentSessionHistoryPanel(props: MobileAgentSessionHistoryPanelProps) {
  return <MobileAgentSessionHistoryPanelContent key={props.hostId} {...props} />
}

function MobileAgentSessionHistoryPanelContent({
  hostId,
  worktreeId,
  name = ''
}: MobileAgentSessionHistoryPanelProps) {
  // Not `useRouter`: inside the shell's page this screen is one document standing in for one
  // screen, and the session it resumes into is a native route the shell has to push.
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
  const [resumeNotice, setResumeNotice] = useState<ResumeNotice | null>(null)
  const [issuesShown, setIssuesShown] = useState(false)
  const [scrolled, setScrolled] = useState(false)
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
    [sessions, query, scope, scopeFilterPaths, activeWorktreePath, now]
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
        setResumeNotice({ tone: 'error', text: 'Waiting for your desktop to reconnect.' })
        triggerError()
        return
      }
      if (!session.sessionId) {
        setResumeNotice({
          tone: 'error',
          text: 'This session can’t be resumed: it has no resume id.'
        })
        triggerError()
        return
      }

      const assertCurrentOwner = claimResumeOwnership()
      resumeLaunchInFlightRef.current = true
      setResumingSessionId(session.id)
      setResumeNotice(null)
      try {
        const {
          repos,
          folderWorkspaces,
          projectGroups,
          settings,
          worktrees: freshWorktrees
        } = await loadMobileResumeMetadata(client)
        assertCurrentOwner()
        const target = resolveMobileAiVaultSessionResumeTarget({
          session,
          activeWorktreeId: worktreeId,
          // Why: resolve against live worktrees so a workspace deleted or
          // archived since panel mount can't be picked; the mount-time list is
          // only a fallback when the fresh fetch fails.
          worktrees: freshWorktrees ?? worktrees,
          repos,
          folderWorkspaces,
          projectGroups
        })
        if (target.status !== 'ready') {
          setResumeNotice({ tone: 'error', text: target.message })
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
          setResumeNotice({
            tone: 'error',
            text: 'Couldn’t tell which platform your desktop runs.'
          })
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
        setResumeNotice({ tone: 'info', text: 'Agent session queued.' })
        router.push(
          `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(target.worktreeId)}` as Parameters<
            typeof router.push
          >[0]
        )
      } catch (err) {
        triggerError()
        setResumeNotice({
          tone: 'error',
          text: err instanceof Error ? err.message : 'Failed to resume session.'
        })
      } finally {
        resumeLaunchInFlightRef.current = false
        setResumingSessionId(null)
      }
    },
    [
      client,
      connState,
      hostId,
      resumeHost,
      hostTerminalWindowsShell,
      router,
      worktreeId,
      worktrees,
      claimResumeOwnership
    ]
  )

  const waitingForDesktop = screenState.kind === 'error' && connState !== 'connected'
  const header = (
    <View style={styles.controls}>
      <MobileSegmentedControl
        segments={SCOPE_SEGMENTS}
        selected={scope}
        onSelect={onSelectScope}
        fill
        testIDPrefix="agent-history-scope-"
      />
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search sessions, repo:, path:"
        accessibilityLabel="Search agent sessions"
      />
      {issues.length > 0 ? (
        <View style={styles.notice}>
          <Banner
            tone="warning"
            message={`${issues.length} ${issues.length === 1 ? 'transcript' : 'transcripts'} couldn’t be read and ${issues.length === 1 ? 'isn’t' : 'aren’t'} listed.`}
            action={{
              label: issuesShown ? 'Hide details' : 'Show details',
              onPress: () => setIssuesShown((shown) => !shown)
            }}
          />
          {/* Cancels the notice's gap while shut and carries it inside, so it eases in too. */}
          <View style={styles.issueFrame}>
            <Collapsible open={issuesShown}>
              <View style={styles.issueGap}>
                <View style={styles.issueList}>
                  {issues.map((issue) => (
                    <View key={`${issue.path}\n${issue.message}`} style={styles.issueRow}>
                      <Text style={styles.issuePath} numberOfLines={2}>
                        {issue.path}
                      </Text>
                      <Text style={styles.issueMessage}>{issue.message}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </Collapsible>
          </View>
        </View>
      ) : null}
      {resumeNotice ? (
        <View style={styles.notice}>
          <Banner
            tone={resumeNotice.tone}
            message={resumeNotice.text}
            onDismiss={() => setResumeNotice(null)}
          />
        </View>
      ) : null}
    </View>
  )

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <NavBar
          title="Agent session history"
          subtitle={worktreeLabel}
          onBack={() => router.back()}
          scrolled={scrolled}
          trailing={
            screenState.kind === 'ready' ? (
              <MobileNavRefreshButton
                busy={refreshing}
                onPress={() => void onRefresh()}
                accessibilityLabel="Refresh agent sessions"
              />
            ) : undefined
          }
        />
      </SafeAreaView>

      {screenState.kind === 'loading' ? (
        <StateView loading title="Loading agent sessions…" />
      ) : screenState.kind === 'unsupported' ? (
        <StateView
          icon={History}
          title="History isn’t available yet"
          message="Update Orca on your desktop to browse agent session history."
        />
      ) : waitingForDesktop ? (
        <StateView
          icon={CloudOff}
          title="Waiting for desktop"
          message="Agent sessions load once your desktop is back online."
          primary={retry ? { label: 'Retry', onPress: retry } : undefined}
        />
      ) : screenState.kind === 'error' ? (
        <StateView
          icon={CircleAlert}
          title="Couldn’t load agent sessions"
          message={screenState.message}
          primary={retry ? { label: 'Retry', onPress: retry } : undefined}
        />
      ) : (
        <>
          {header}
          {sections.length === 0 ? (
            query ? (
              <StateView
                icon={SearchX}
                title="No matches"
                message="No sessions match your search."
                secondary={{ label: 'Clear search', onPress: () => setQuery('') }}
              />
            ) : (
              <StateView
                icon={History}
                title="No agent sessions"
                message="Past agent sessions in this scope show up here."
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
              onScrolledChange={setScrolled}
            />
          )}
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
