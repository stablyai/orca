import { replaceEqualDeep, useQueryClient } from '@tanstack/react-query'
import { restoreStoredHostQueries } from '../query/host-query-persistence'
import { connectionHostStatus } from '../query/host-status-query'
import type { ClientSettingsActionsModel } from './use-mobile-tasks-client-settings-actions'
import { resolveHydratedTaskViewState } from './mobile-tasks-hydrated-view-state'
import { taskRuntimeStatusRead } from './mobile-task-runtime-operations'
import { firstPaintTaskKeys } from './task-query-storage'
import {
  readKeptTaskHydration,
  readTaskHydration,
  readTaskJiraStatus,
  taskHydrationWrites,
  type TaskHydration
} from './task-queries'
import { MOBILE_TASKS_CAPABILITY, useEffect, useLayoutEffect } from './mobile-tasks-dependencies'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider
} from '../../../src/shared/work-items/task-providers'
import { useRef, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { EMPTY_GITHUB_PROJECT_SETTINGS } from './mobile-tasks-legacy-foundation'

export function useMobileTasksRuntimeHydration(model: ClientSettingsActionsModel) {
  const {
    client,
    connState,
    defaultLinearTeamSelectionRef,
    hostId,
    provider,
    requestedTaskSource,
    resetGitHubItemsState,
    resetWorkspaceCreateState,
    setActionItem,
    setAppliedQuery,
    setDefaultGitHubPreset,
    setDetailPayload,
    setError,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setGithubProjectHiddenFieldIdsByView,
    setGithubProjectSettings,
    setGithubProjectTable,
    setItems,
    setLinearConnected,
    setJiraConnection,
    jiraStatusRequestIdRef,
    setJiraFilter,
    setLinearFilter,
    setLinearStatusPickerItem,
    setLinearTeams,
    setLinearWorkspaces,
    setMergeMethodProjectRow,
    setMergeMethodTaskItem,
    setOrcaYamlTrustPrompt,
    setPendingGitHubProjectViewSelection,
    setPendingHostedMerge,
    setPendingHostedStateChange,
    setPendingProjectGitHubMerge,
    setProjectRepoNotInOrca,
    setProjectRowDetail,
    setProjectRowItem,
    setProvider,
    setQuery,
    setRuntimeTaskSettings,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    setShowCreateTargetPicker,
    setShowCreateTask,
    setShowGitHubIssueSourcePicker,
    setShowGitHubKindPicker,
    setShowGitHubPagePicker,
    setShowGitHubPresetPicker,
    setShowGitHubProjectFieldsPicker,
    setShowGitHubProjectPicker,
    setShowGitHubProjectViewPicker,
    setShowGitLabFilterPicker,
    setShowGitLabViewPicker,
    setShowLinearConnect,
    setShowLinearDisplayPicker,
    setShowLinearFilterPicker,
    setShowLinearTeamPicker,
    setShowLinearWorkspacePicker,
    setShowRepoPicker,
    setSelectedRepoIds,
    setShowFilterSheet,
    setTaskStateHydrated,
    setTasksSupportState,
    setTrustedOrcaHooks,
    setVisibleProviders,
    taskResumeRef,
    visibleProviders
  } = model
  const queryClient = useQueryClient()
  // Bumped by Retry after a failed hydration, which leaves support unknown.
  const [hydrationAttempt, setHydrationAttempt] = useState(0)
  // Set once this screen has drawn a view, so a dropped connection keeps what the user has on screen.
  const viewShownRef = useRef(false)
  // What the screen draws: source, filters and query. Safe from a stored copy, which nothing acts on.
  function applyView(hydration: TaskHydration): void {
    viewShownRef.current = true
    const { settings } = hydration
    const resume = hydration.ui?.taskResumeState ?? {}
    setGithubProjectHiddenFieldIdsByView(resume.githubProjectHiddenFieldIdsByView ?? {})

    const preferredProviders = normalizeVisibleTaskProviders(settings.visibleTaskProviders)
    const linearIsConnected = hydration.linearConnected
    const availableProviders = filterAvailableTaskProviders(preferredProviders, {
      gitlabInstalled: hydration.glabInstalled,
      linearConnected: linearIsConnected
    })
    const nextVisibleProviders =
      preferredProviders.includes('linear') && !availableProviders.includes('linear')
        ? [...availableProviders, 'linear' as const]
        : availableProviders
    setLinearConnected(linearIsConnected)
    if (!linearIsConnected) {
      setLinearWorkspaces([])
      setLinearTeams([])
      setSelectedLinearTeamIds(new Set())
      setSelectedLinearWorkspaceId(null)
    }
    setSelectedRepoIds(new Set(settings.defaultRepoSelection ?? []))
    defaultLinearTeamSelectionRef.current = settings.defaultLinearTeamSelection ?? null
    const view = resolveHydratedTaskViewState({
      settings,
      resume,
      requestedTaskSource,
      visibleProviders: nextVisibleProviders
    })

    setVisibleProviders(nextVisibleProviders)
    setProvider(view.provider)
    setGithubMode(resume.githubMode === 'project' ? 'project' : 'items')
    setDefaultGitHubPreset(view.defaultGithubPreset)
    setGithubPreset(view.githubPreset)
    setGithubKind(view.githubKind)
    setLinearFilter(view.linearFilter)
    setJiraFilter(view.jiraFilter)
    setGithubProjectSettings(settings.githubProjects ?? EMPTY_GITHUB_PROJECT_SETTINGS)
    setQuery(view.query)
    setAppliedQuery(view.appliedQuery)
  }

  // Until Tasks is ready the screen keeps the view it last had, from this document or an earlier launch.
  function applyKeptView(kept: ReturnType<typeof readKeptTaskHydration>): void {
    if (kept.hydration && !viewShownRef.current) {
      if (kept.jira) {
        setJiraConnection(kept.jira)
      }
      applyView(kept.hydration)
    }
  }

  // A screen opened in a document that booted on another route reads its stored view now.
  useEffect(() => {
    let stale = false
    void restoreStoredHostQueries(queryClient, firstPaintTaskKeys(hostId))
      .catch(() => {})
      .then(() => {
        if (!stale) {
          applyKeptView(readKeptTaskHydration(queryClient, hostId))
        }
      })
    return () => {
      stale = true
    }
  }, [hostId, queryClient])

  // Open items, the create sheet and the workspace form outlive reconnects so typed drafts survive; their drawers hide until Tasks is ready again.
  // A layout effect, so a revisit opens on the kept hydration before the first frame.
  useLayoutEffect(() => {
    // A read from this document: Tasks acts on it (launch settings, hook trust, resume writes).
    function applyHydration(hydration: TaskHydration): void {
      setRuntimeTaskSettings(hydration.settings)
      setTrustedOrcaHooks(hydration.ui?.trustedOrcaHooks ?? {})
      taskResumeRef.current = hydration.ui?.taskResumeState ?? {}
      applyView(hydration)
      setTaskStateHydrated(true)
    }

    if (!client || connState !== 'connected') {
      taskResumeRef.current = {}
      setRuntimeTaskSettings({})
      setTrustedOrcaHooks({})
      setOrcaYamlTrustPrompt(null)
      setGithubProjectHiddenFieldIdsByView({})
      setTaskStateHydrated(false)
      setTasksSupportState({ kind: 'unknown', client: null })
      setShowLinearWorkspacePicker(false)
      setShowLinearTeamPicker(false)
      setShowLinearDisplayPicker(false)
      setShowLinearConnect(false)
      setShowGitHubKindPicker(false)
      setShowGitHubPresetPicker(false)
      setShowGitLabViewPicker(false)
      setShowGitLabFilterPicker(false)
      setShowLinearFilterPicker(false)
      setShowFilterSheet(false)
      setShowRepoPicker(false)
      setShowGitHubIssueSourcePicker(false)
      setShowGitHubPagePicker(false)
      setShowGitHubProjectPicker(false)
      setShowGitHubProjectViewPicker(false)
      setShowGitHubProjectFieldsPicker(false)
      setPendingGitHubProjectViewSelection(null)
      setProjectRepoNotInOrca(null)
      setDetailPayload(null)
      setProjectRowDetail(null)
      setShowCreateTargetPicker(false)
      setLinearStatusPickerItem(null)
      setPendingHostedMerge(null)
      setPendingProjectGitHubMerge(null)
      setPendingHostedStateChange(null)
      setMergeMethodTaskItem(null)
      setMergeMethodProjectRow(null)
      applyKeptView(readKeptTaskHydration(queryClient, hostId))
      return
    }

    let stale = false
    setTaskStateHydrated(false)
    setTasksSupportState({ kind: 'unknown', client })
    setShowLinearWorkspacePicker(false)
    setShowLinearTeamPicker(false)
    setShowLinearDisplayPicker(false)
    setShowLinearConnect(false)
    setShowGitHubKindPicker(false)
    setShowGitHubPresetPicker(false)
    setShowGitLabViewPicker(false)
    setShowGitLabFilterPicker(false)
    setShowLinearFilterPicker(false)
    setShowFilterSheet(false)
    setShowRepoPicker(false)
    setShowGitHubIssueSourcePicker(false)
    setShowGitHubPagePicker(false)
    setShowGitHubProjectPicker(false)
    setShowGitHubProjectViewPicker(false)
    setShowGitHubProjectFieldsPicker(false)
    setPendingGitHubProjectViewSelection(null)
    setProjectRepoNotInOrca(null)
    setDetailPayload(null)
    setProjectRowDetail(null)
    setShowCreateTargetPicker(false)
    setLinearStatusPickerItem(null)
    setPendingHostedMerge(null)
    setPendingProjectGitHubMerge(null)
    setPendingHostedStateChange(null)
    setMergeMethodTaskItem(null)
    setMergeMethodProjectRow(null)

    // A revisit opens on the hydration this document last read for the host; the reads below confirm or correct it.
    const kept = readKeptTaskHydration(queryClient, hostId)
    const landed = connectionHostStatus(client)
    let applied: TaskHydration | undefined
    if (
      kept.hydration &&
      !kept.stored &&
      landed &&
      taskRuntimeStatusRead.interpret(landed.reply).capabilities?.includes(MOBILE_TASKS_CAPABILITY)
    ) {
      setTasksSupportState({ kind: 'supported', client })
      if (kept.jira) {
        setJiraConnection(kept.jira)
      }
      applyHydration(kept.hydration)
      applied = kept.hydration
    } else {
      applyKeptView(kept)
    }

    const hydrateTaskState = async (): Promise<void> => {
      const statusReply = await taskRuntimeStatusRead.request(client)
      if (stale) {
        return
      }
      // Fence before interpretation so stale screens cannot raise refusals they no longer own.
      const status = taskRuntimeStatusRead.interpret(statusReply)
      if (!status.capabilities?.includes(MOBILE_TASKS_CAPABILITY)) {
        // Older hosts can pair without Tasks support; never send them task-specific methods.
        setTasksSupportState({ kind: 'unsupported', client })
        setItems([])
        resetGitHubItemsState()
        setGithubProjectTable(null)
        setShowLinearWorkspacePicker(false)
        setShowLinearTeamPicker(false)
        setShowLinearDisplayPicker(false)
        setShowLinearConnect(false)
        setShowGitHubKindPicker(false)
        setShowGitHubPresetPicker(false)
        setShowGitLabViewPicker(false)
        setShowGitLabFilterPicker(false)
        setShowLinearFilterPicker(false)
        setShowFilterSheet(false)
        setShowRepoPicker(false)
        setShowGitHubIssueSourcePicker(false)
        setShowGitHubPagePicker(false)
        setShowGitHubProjectPicker(false)
        setShowGitHubProjectViewPicker(false)
        setShowGitHubProjectFieldsPicker(false)
        setPendingGitHubProjectViewSelection(null)
        setActionItem(null)
        setProjectRowItem(null)
        setProjectRepoNotInOrca(null)
        setDetailPayload(null)
        setProjectRowDetail(null)
        setShowCreateTask(false)
        setShowCreateTargetPicker(false)
        setLinearStatusPickerItem(null)
        setPendingHostedMerge(null)
        setPendingProjectGitHubMerge(null)
        setPendingHostedStateChange(null)
        setMergeMethodTaskItem(null)
        setMergeMethodProjectRow(null)
        resetWorkspaceCreateState()
        setTaskStateHydrated(false)
        return
      }
      setTasksSupportState({ kind: 'supported', client })
      setError('')
      // Jira is advisory and must not delay the other providers.
      const jiraRequestId = ++jiraStatusRequestIdRef.current
      void readTaskJiraStatus(queryClient, hostId, client)
        .then((connection) => {
          if (!stale && jiraStatusRequestIdRef.current === jiraRequestId) {
            // Unchanged keeps its identity, so the list read it feeds is not restarted.
            setJiraConnection((current) => replaceEqualDeep(current, connection))
          }
        })
        .catch(() => {})
      const writes = taskHydrationWrites(queryClient, hostId)
      const fresh = await readTaskHydration(queryClient, hostId, client)
      if (stale) {
        return
      }
      if (applied && taskHydrationWrites(queryClient, hostId) !== writes) {
        // This phone changed a setting while the read was out; keep its view and re-read so the kept copy has the write.
        void readTaskHydration(queryClient, hostId, client).catch(() => {})
        return
      }
      if (applied && replaceEqualDeep(applied, fresh) === applied) {
        return
      }
      applyHydration(fresh)
    }

    void hydrateTaskState().catch((err) => {
      if (stale) {
        return
      }
      setError(
        err instanceof Error
          ? err.message
          : translate('tasks.runtimeHydration.loadFailed', 'Failed to load Tasks settings')
      )
      // Back to unknown so the error offers the hydration retry; loadTasks no-ops until hydrated.
      setTasksSupportState({ kind: 'unknown', client })
      setTaskStateHydrated(false)
    })

    return () => {
      stale = true
    }
  }, [client, connState, hydrationAttempt, requestedTaskSource])

  useEffect(() => {
    if (visibleProviders.includes(provider)) {
      return
    }
    setProvider(resolveVisibleTaskProvider(provider, visibleProviders))
  }, [provider, visibleProviders])

  return Object.assign(model, {
    retryTasksHydration: () => setHydrationAttempt((attempt) => attempt + 1)
  })
}

export type RuntimeHydrationModel = ReturnType<typeof useMobileTasksRuntimeHydration>
