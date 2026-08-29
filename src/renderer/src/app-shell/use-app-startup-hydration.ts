import { useEffect, useRef } from 'react'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { installCodexDetachedPaneRestartExecutor } from '@/components/terminal-pane/codex-detached-pane-restart-scheduler'
import { useAppStore } from '../store'
import { useStartupActions } from './use-app-startup-actions'
import { WORKTREE_REFRESH_CONCURRENCY } from '../store/slices/worktrees'
import { sweepRestoredCodexPanesForStaleAccounts } from '../lib/codex-stale-pane-sweep'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '../lib/workspace-session-host-persistence'
import {
  collectFolderWorkspaceKeysFromSession,
  collectWorktreeHydrationRepoIdsFromSession
} from '../lib/workspace-session-hydration-keys'
import { hydratePersistedUIAfterStartupRead } from '../lib/startup-ui-hydration'
import {
  logRendererStartupDiagnostic,
  timeRendererStartupStep,
  timeRendererStartupSyncStep
} from '../startup/startup-diagnostics'
import { recoverFromDegradedStartup } from '../startup/startup-degraded-recovery'
import { restoreSshConnectionsForStartup } from '../startup/startup-ssh-connection-restore'
import { publishTerminalViewAttributesAtAppStart } from '../components/terminal-pane/terminal-appearance'
import { getSystemPrefersDark } from '../lib/terminal-theme'
import {
  collectTerminalProviderSnapshotPtyIds,
  refreshTerminalProviderSnapshotCapabilities
} from '../components/terminal/terminal-provider-snapshot-capability'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import { restoreLocalStructuredSessionTabsOnce } from '../runtime/local-structured-session-tabs-sync'

async function listRuntimeSessionHostIdsForStartup(): Promise<ExecutionHostId[]> {
  try {
    return (await window.api.runtimeEnvironments.list()).map((environment) =>
      toRuntimeExecutionHostId(environment.id)
    )
  } catch (err) {
    console.warn('Failed to list runtime session hosts for startup:', err)
    return []
  }
}

/**
 * Runs the renderer's one-shot boot chain: settings, persisted UI, the local repo catalog,
 * the workspace session, SSH reconnect, and terminal restoration — then unlocks the session
 * writer. A failure anywhere leaves disk state untouched and boots in degraded no-save mode.
 */
export function useAppStartupHydration(onOnboardingLoaded: (state: OnboardingState) => void): void {
  const actions = useStartupActions()
  // Why a ref: the boot chain must not restart if a caller passes a new callback identity.
  // Synced in an effect (declared before the chain below, so it lands first on mount) because
  // a render-phase write can leak from a render React discards.
  const onOnboardingLoadedRef = useRef(onOnboardingLoaded)
  useEffect(() => {
    onOnboardingLoadedRef.current = onOnboardingLoaded
  }, [onOnboardingLoaded])

  useEffect(() => installCodexDetachedPaneRestartExecutor(), [])

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false
    // Why: declared outside the async block so cleanup can abort it — under StrictMode the first (unmounted) pass would otherwise keep spawning PTYs.
    const abortController = new AbortController()

    // Why (issue #1158): hydrate persisted UI right after ui.get() succeeds; the UI writer is gated only on persistedUIReady, so later default fallback would serialize defaults to disk.
    let uiHydrated = false
    // Why (issue #1158): track whether success-path reconnect started so the catch doesn't re-run it — re-entering on partially-mutated state would double-set ptyIds and drain pending* twice.
    let reconnectStarted = false
    void (async () => {
      const startupStartedAt = performance.now()
      logRendererStartupDiagnostic('startup-chain-start')
      try {
        // Why: nothing in the hydration chain reads profile state synchronously, so don't let it add a serial IPC round-trip before fetchSettings.
        void actions.fetchOrcaProfiles()
        // Why: publish local settings before persisted UI/catalog work; a saved remote owner's defaults can spend the full connect timeout.
        await timeRendererStartupStep('fetch-settings', () =>
          actions.fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
        )
        // Why: hidden-at-launch PTYs can query OSC 10/11 before any pane mounts; publish view attributes as soon as settings exist so main's silent-until-push responder has data.
        publishTerminalViewAttributesAtAppStart(
          useAppStore.getState().settings,
          getSystemPrefersDark()
        )
        // Why: start keybindings + onboarding now so their IPC overlaps the local catalog scans; await them at their original spots. The .catch marks rejections handled if an earlier await throws first.
        // Why: browser session profiles are NOT started early — on a remote runtime the RPC may be unconnected and a failed fetch clears the list.
        const keybindingsPromise = timeRendererStartupStep('fetch-keybindings', () =>
          actions.fetchKeybindings()
        )
        keybindingsPromise.catch(() => {})
        const onboardingPromise = timeRendererStartupStep('onboarding-get', () =>
          window.api.onboarding.get()
        )
        onboardingPromise.catch(() => {})
        // Why: await ui.get() (not overlap) so persisted view settings hydrate before the local catalog/session steps and first paint reflects them.
        const persistedUI = await timeRendererStartupStep('ui-get', () => window.api.ui.get())
        uiHydrated = timeRendererStartupSyncStep('hydrate-persisted-ui', () =>
          hydratePersistedUIAfterStartupRead({
            persistedUI,
            cancelled,
            hydratePersistedUI: actions.hydratePersistedUI
          })
        )
        // Why: list-runtime-session-hosts reads no repo state, so overlap it with the repo scan
        // instead of paying its IPC round-trip serially before repos. .catch marks rejections handled
        // if an earlier await throws first; the value is awaited below and surfaces any error there.
        const runtimeHostsPromise = timeRendererStartupStep(
          'list-runtime-session-hosts',
          listRuntimeSessionHostIdsForStartup
        )
        runtimeHostsPromise.catch(() => {})
        // Why: saved remote runtimes can spend the full connect timeout; load only the local catalog for first paint and refresh remotes after hydration.
        await timeRendererStartupStep('fetch-repos-local', () =>
          actions.fetchReposForAllHosts({ remoteHosts: 'skip' })
        )
        await timeRendererStartupStep('repo-catalog-settlement', () =>
          actions.awaitLocalRepoCatalogSettlement()
        )
        // Why: folder workspaces merge against projectGroups (repos.ts fetchFolderWorkspacesForAllHosts),
        // so keep this chain ordered while overlapping it with session-scoped hydration.
        const localCatalogChain = (async () => {
          await timeRendererStartupStep('fetch-project-groups-local', () =>
            actions.fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
          )
          await timeRendererStartupStep('fetch-folder-workspaces-local', () =>
            actions.fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
          )
        })()
        const sessionReadPromise = runtimeHostsPromise.then((startupRuntimeHostIds) =>
          // Why: include saved runtime host ids so per-host worktree session slices restore from local settings without waiting on network reachability; unreadable partitions skip.
          timeRendererStartupStep('session-get', () =>
            fetchWorkspaceSessionWithRuntimeHostOwners(
              window.api.session,
              useAppStore.getState().repos,
              startupRuntimeHostIds
            )
          )
        )
        const hydrationSessionChain = sessionReadPromise.then(async (sessionRead) => {
          const hydrationRepoIds = collectWorktreeHydrationRepoIdsFromSession(
            sessionRead.session,
            sessionRead.runtimeHostIdByWorkspaceSessionKey
          )
          const hydrationRepoIdSet = new Set(hydrationRepoIds)
          const hydrationRepos = useAppStore.getState().repos.filter(
            (repo) =>
              hydrationRepoIdSet.has(repo.id) &&
              // Why: disconnected SSH repos hydrate from local metadata; only runtime-owned repos use placeholders.
              parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
          )
          // Why: worktree refresh can spawn host Git; wait for main's shell-PATH generation fence first.
          await timeRendererStartupStep('first-window-services-await', () =>
            window.api.app.awaitFirstWindowStartupServices()
          )
          await timeRendererStartupStep('fetch-hydration-worktrees', () =>
            mapWithConcurrency(hydrationRepos, WORKTREE_REFRESH_CONCURRENCY, (repo) =>
              actions.fetchWorktrees(repo.id, { executionHostId: getRepoExecutionHostId(repo) })
            )
          )
          return sessionRead
        })
        // Why: wait for both writers to settle before recovery so neither can mutate hydrated state afterward.
        const [sessionOutcome, catalogOutcome] = await Promise.allSettled([
          hydrationSessionChain,
          localCatalogChain
        ])
        if (sessionOutcome.status === 'rejected') {
          throw sessionOutcome.reason
        }
        if (catalogOutcome.status === 'rejected') {
          throw catalogOutcome.reason
        }
        const sessionRead = sessionOutcome.value
        await keybindingsPromise
        await timeRendererStartupStep('repo-catalog-final-settlement', () =>
          actions.awaitLocalRepoCatalogSettlement()
        )
        if (!cancelled) {
          const sessionHydrationOptions = {
            additionalValidWorkspaceKeys: collectFolderWorkspaceKeysFromSession(sessionRead.session)
          }
          timeRendererStartupSyncStep('hydrate-session-stores', () => {
            actions.hydrateWorkspaceSession(sessionRead.session, {
              ...sessionHydrationOptions,
              runtimeHostIdByWorkspaceSessionKey: sessionRead.runtimeHostIdByWorkspaceSessionKey
            })
            actions.hydrateTabsSession(sessionRead.session, sessionHydrationOptions)
            actions.hydrateEditorSession(sessionRead.session, sessionHydrationOptions)
            actions.hydrateBrowserSession(sessionRead.session, sessionHydrationOptions)
          })
          await timeRendererStartupStep('prepare-terminal-startup-restoration', () =>
            window.api.app.prepareTerminalStartupRestoration()
          )
          if (cancelled) {
            return
          }
          // Why: prune visit timestamps AFTER hydration (earlier, worktreesByRepo may be empty and prune would drop entries for worktrees about to appear); seed the active worktree if missing.
          // See docs/cmd-j-empty-query-ordering.md.
          timeRendererStartupSyncStep('visit-timestamp-prune', () => {
            actions.pruneLastVisitedTimestamps()
            actions.seedActiveWorktreeLastVisitedIfMissing()
          })
          await timeRendererStartupStep('fetch-browser-session-profiles', () =>
            actions.fetchBrowserSessionProfiles()
          )
          const onboardingState = await onboardingPromise
          if (!cancelled) {
            onOnboardingLoadedRef.current(onboardingState)
          }

          // Why: re-establish SSH before terminal reconnect so SSH-backed tabs route through pty.attach; passphrase targets defer to tab focus to avoid stacked credential dialogs.
          // Why: never dial runtime-owned (ephemeral-VM) targets from the renderer — ssh.connect would dispose the runtime layer's live relay session; filter them out here too.
          const connectionIds = (sessionRead.session.activeConnectionIdsAtShutdown ?? []).filter(
            (targetId) => !isRuntimeOwnedSshTargetId(targetId)
          )
          if (connectionIds.length > 0) {
            try {
              await restoreSshConnectionsForStartup({
                connectionIds,
                setDeferredSshReconnectTargets: actions.setDeferredSshReconnectTargets,
                publishSshConnectionState: actions.setSshConnectionState
              })
            } catch (err) {
              console.warn('SSH startup reconnect failed:', err)
            }
          } else {
            logRendererStartupDiagnostic('ssh-reconnect-skipped', { connectionIds: 0 })
          }

          // first-window-services-await already fenced worktree hydration; terminal recovery reuses that ready state.
          await timeRendererStartupStep('recover-legacy-worker-terminals-pre-reconnect', () =>
            window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
          )
          await timeRendererStartupStep('terminal-provider-snapshot-capabilities', () => {
            return refreshTerminalProviderSnapshotCapabilities(
              collectTerminalProviderSnapshotPtyIds(useAppStore.getState())
            )
          })
          reconnectStarted = true
          await timeRendererStartupStep('reconnect-terminals', () =>
            actions.reconnectPersistedTerminals(abortController.signal)
          )
          await timeRendererStartupStep('recover-legacy-worker-terminals-post-reconnect', () =>
            window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
          )
          await timeRendererStartupStep('project-structured-session-tabs', () =>
            restoreLocalStructuredSessionTabsOnce()
          )
          if (cancelled) {
            return
          }
          // Why here: reconnect just published restored PTY ids; sweeping them now
          // re-offers stale Codex panes whose tabs never mount this session.
          sweepRestoredCodexPanesForStaleAccounts(useAppStore.getState())
          syncZoomCSSVar()
          // Why (issue #1158): unlock the session writer only after hydration and all dependent steps succeeded, so a mid-startup throw can't serialize partially-mutated state to disk.
          actions.setHydrationSucceeded(true)
          actions.setTerminalStartupRestorationReady(true)
          logRendererStartupDiagnostic('startup-hydration-done', {
            durationMs: Math.round(performance.now() - startupStartedAt)
          })
          void (async () => {
            try {
              try {
                // Why: remote rows must not render under a fallback visibility while their owner default is still loading.
                await timeRendererStartupStep('owner-visibility-defaults', () =>
                  actions.awaitOwnerWorktreeVisibilityDefaultsHydration()
                )
                await timeRendererStartupStep('remote-catalog-refresh', async () => {
                  await actions.fetchReposForAllHosts()
                  await actions.fetchProjectGroupsForAllHosts()
                  await actions.fetchFolderWorkspacesForAllHosts()
                })
              } catch (err) {
                console.warn('Remote startup catalog refresh failed:', err)
              }
              if (!cancelled) {
                try {
                  await timeRendererStartupStep('remote-worktree-refresh', async () => {
                    // Why: the full scan is not required for session recovery, so keep it off the startup-critical path.
                    await actions.fetchAllWorktrees()
                    // Why: the startup prune only saw session-referenced repos; use the deferred scan's
                    // authoritative results to drop deleted-worktree visit timestamps that would
                    // otherwise accumulate unbounded (disconnected SSH stays non-authoritative and is kept).
                    actions.pruneLastVisitedTimestamps()
                    await actions.fetchWorktreeLineage()
                  })
                } catch (err) {
                  console.warn('Deferred startup worktree refresh failed:', err)
                }
              }
            } finally {
              if (!cancelled) {
                useAppStore.setState({ startupWorktreeRefreshCompleted: true })
              }
            }
          })()
        }
      } catch (error) {
        await recoverFromDegradedStartup({
          error,
          uiHydrated,
          reconnectStarted,
          isCancelled: () => cancelled,
          hydratePersistedUI: actions.hydratePersistedUI,
          reconnectPersistedTerminals: actions.reconnectPersistedTerminals,
          abortSignal: abortController.signal
        })
      }
      void actions.initGitHubCache()
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [actions])
}
