import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import type {
  ClickUpTask,
  ClickUpTaskFilter,
  ClickUpWorkspaceSelection
} from '../../../shared/clickup-types'
import { isClickUpTaskFilter } from '../../../shared/clickup-task-filter'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getLinkedWorkItemSuggestedName } from '../../../shared/workspace-name'
import { useAppStore } from '@/store'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { ClickUpApiTokenDialog } from '@/components/clickup-api-token-dialog'
import { ClickUpCreateTaskDialog } from '@/components/clickup-create-task-dialog'
import { ClickUpTaskDetailSheet } from '@/components/ClickUpTaskDetailSheet'
import { ClickUpRateLimitNotice } from '@/components/clickup-rate-limit-notice'
import { ClickUpSprintListPicker } from '@/components/clickup-sprint-list-picker'
import { ClickUpTaskGantt } from '@/components/clickup-task-gantt'
import { ClickUpTaskListTable } from '@/components/clickup-task-list-table'
import {
  ClickUpSpaceSelect,
  ClickUpStatusMenu,
  ClickUpViewToggle
} from '@/components/clickup-task-scope-filters'
import { useClickUpTaskScope } from '@/components/use-clickup-task-scope'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  getClickUpFilters,
  linkedClickUpTaskContext,
  clickUpTaskReference,
  matchesClickUpTaskFilter
} from './clickup-task-page-model'

export function ClickUpTaskPageSurface({
  sourceContext,
  onHide
}: {
  sourceContext: TaskSourceContext | null
  onHide: () => void
}): React.JSX.Element {
  useTranslation()
  const status = useAppStore((state) => state.clickUpStatus)
  const statusChecked = useAppStore((state) => state.clickUpStatusChecked)
  const checkConnection = useAppStore((state) => state.checkClickUpConnection)
  const selectWorkspace = useAppStore((state) => state.selectClickUpWorkspace)
  const listTasks = useAppStore((state) => state.listClickUpTasks)
  const searchTasks = useAppStore((state) => state.searchClickUpTasks)
  const openModal = useAppStore((state) => state.openModal)
  const [tasks, setTasks] = useState<ClickUpTask[]>([])
  const [filter, setFilter] = useState<ClickUpTaskFilter>('assigned')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [selectedTask, setSelectedTask] = useState<ClickUpTask | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const forcedForNonceRef = useRef(-1)

  const workspaces = status.workspaces ?? []
  const selectedWorkspaceId =
    status.selectedWorkspaceId ?? status.activeWorkspaceId ?? workspaces[0]?.id ?? null
  const scope = useClickUpTaskScope({
    sourceContext,
    workspaceId: selectedWorkspaceId,
    enabled: status.connected === true
  })
  const taskScope = scope.taskScope

  useEffect(() => {
    if (!statusChecked) {
      void checkConnection()
    }
  }, [checkConnection, statusChecked])

  useEffect(() => {
    if (!status.connected) {
      setTasks([])
      return
    }
    if (!scope.ready) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const shouldForce = refreshNonce !== forcedForNonceRef.current
    forcedForNonceRef.current = refreshNonce
    const readOptions = { force: shouldForce, sourceContext, taskScope }
    // Why 500 when scoped: browsing a Space or Sprint should show all of it.
    const request = appliedQuery.trim()
      ? searchTasks(appliedQuery, 50, readOptions)
      : listTasks(filter, taskScope ? 500 : 100, readOptions)
    void request
      .then((nextTasks) => {
        if (!cancelled) {
          setTasks(nextTasks)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load ClickUp tasks.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    appliedQuery,
    filter,
    listTasks,
    refreshNonce,
    scope.ready,
    searchTasks,
    sourceContext,
    status.connected,
    taskScope
  ])

  // Why: search results arrive ranked (exact id, then name prefix, then
  // substring); re-sorting by update time would bury the exact match. Search
  // ignores the assignee/state filter server-side, so apply it here.
  const viewerId = status.viewer?.id
  const visibleTasks = useMemo(
    () =>
      appliedQuery
        ? tasks.filter((task) => matchesClickUpTaskFilter(task, filter, viewerId))
        : [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [appliedQuery, filter, tasks, viewerId]
  )

  const handleWorkspaceChange = useCallback(
    (workspaceId: ClickUpWorkspaceSelection) => {
      setTasks([])
      setSelectedTask(null)
      setLoading(true)
      void selectWorkspace(workspaceId)
        .then(() => setRefreshNonce((value) => value + 1))
        .catch((cause: unknown) => {
          setLoading(false)
          setError(cause instanceof Error ? cause.message : 'Could not switch ClickUp Workspace.')
        })
    },
    [selectWorkspace]
  )

  const handleStartWorkspace = useCallback(
    (task: ClickUpTask) => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        provider: 'clickup',
        type: 'issue',
        number: 0,
        title: `${clickUpTaskReference(task)} ${task.name}`,
        url: task.url,
        clickupIdentifier: task.id,
        clickupWorkspaceId: task.workspaceId,
        linkedContext: {
          provider: 'clickup',
          version: 1,
          renderedText: linkedClickUpTaskContext(task)
        }
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: sourceContext,
        prefilledName: getLinkedWorkItemSuggestedName({ title: task.name }),
        telemetrySource: 'sidebar'
      })
    },
    [openModal, sourceContext]
  )

  if (!statusChecked) {
    return (
      <div className="flex flex-1 items-center justify-center py-14">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!status.connected) {
    return (
      <>
        <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-border bg-muted/50 px-6 py-14 text-center shadow-sm">
          <ClickUpIcon className="mb-4 size-8 text-muted-foreground/60" />
          <p className="text-base font-medium text-foreground">
            {translate('auto.components.clickup.page.connectTitle', 'Connect your ClickUp account')}
          </p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            {translate(
              'auto.components.clickup.page.connectDescription',
              'Browse, create, edit, and start work from ClickUp tasks.'
            )}
          </p>
          <div className="mt-5 flex items-center gap-2">
            <Button onClick={() => setConnectOpen(true)}>
              {translate('auto.components.clickup.page.connect', 'Connect ClickUp')}
            </Button>
            <Button variant="outline" onClick={onHide}>
              {translate('auto.components.clickup.page.hide', 'Hide ClickUp')}
            </Button>
          </div>
        </div>
        <ClickUpApiTokenDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md rounded-b-none border border-border bg-muted/50 p-3 shadow-sm">
        {workspaces.length > 1 ? (
          <Select value={selectedWorkspaceId ?? undefined} onValueChange={handleWorkspaceChange}>
            <SelectTrigger className="h-8 w-[210px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {translate('auto.components.clickup.page.allWorkspaces', 'All Workspaces')}
              </SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={filter}
          onValueChange={(value) => {
            if (isClickUpTaskFilter(value)) {
              setFilter(value)
            }
          }}
        >
          <SelectTrigger className="h-8 w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {getClickUpFilters().map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {scope.spaces.length > 0 ? (
          <ClickUpSpaceSelect
            spaces={scope.spaces}
            spaceId={scope.spaceId}
            onSpaceChange={scope.setSpaceId}
          />
        ) : null}
        {scope.spaceId && scope.lists.length > 0 ? (
          <ClickUpSprintListPicker
            lists={scope.lists}
            sprintFolders={scope.sprintFolders}
            sprintFolderId={scope.sprintFolderId}
            onSprintFolderChange={scope.setSprintFolderId}
            sprints={scope.sprints}
            current={scope.currentSprint}
            selection={scope.sprintSelection}
            onSelectionChange={scope.setSprintSelection}
          />
        ) : null}
        {scope.spaceId && scope.statusOptions.length > 0 ? (
          <ClickUpStatusMenu
            options={scope.statusOptions}
            selected={scope.selectedStatuses}
            onSelectedChange={scope.setSelectedStatuses}
          />
        ) : null}
        <form
          className="flex min-w-[220px] flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setAppliedQuery(query.trim())
          }}
        >
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              'auto.components.clickup.page.searchPlaceholder',
              'Search ClickUp tasks…'
            )}
            className="h-8"
          />
          {query || appliedQuery ? (
            <button
              type="button"
              aria-label={translate('auto.components.clickup.page.clearSearch', 'Clear search')}
              onClick={() => {
                setQuery('')
                setAppliedQuery('')
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </form>
        <ClickUpViewToggle
          view={scope.preferences.view}
          onViewChange={(view) => scope.updatePreferences({ view })}
        />
        <Button variant="outline" size="icon-sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          <span className="sr-only">
            {translate('auto.components.clickup.page.newTask', 'New ClickUp task')}
          </span>
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setRefreshNonce((value) => value + 1)}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          <span className="sr-only">
            {translate('auto.components.clickup.page.refresh', 'Refresh ClickUp tasks')}
          </span>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border bg-background shadow-sm">
        <ClickUpRateLimitNotice />
        {error || scope.error ? (
          <div className="border-b border-border px-4 py-3 text-sm text-destructive">
            {error ?? scope.error}
          </div>
        ) : null}
        {scope.preferences.view === 'gantt' ? (
          <ClickUpTaskGantt
            tasks={visibleTasks}
            zoom={scope.preferences.ganttZoom}
            groupBy={scope.preferences.ganttGroupBy}
            onZoomChange={(ganttZoom) => scope.updatePreferences({ ganttZoom })}
            onGroupByChange={(ganttGroupBy) => scope.updatePreferences({ ganttGroupBy })}
            onOpenTask={setSelectedTask}
          />
        ) : (
          <ClickUpTaskListTable
            tasks={visibleTasks}
            loading={loading}
            error={error}
            onOpenTask={setSelectedTask}
            onStartWorkspace={handleStartWorkspace}
          />
        )}
      </div>
      <ClickUpTaskDetailSheet
        task={selectedTask}
        sourceContext={sourceContext}
        onClose={() => setSelectedTask(null)}
        onStartWorkspace={handleStartWorkspace}
        onTaskChanged={(task) => {
          setSelectedTask(task)
          setTasks((current) => current.map((item) => (item.id === task.id ? task : item)))
        }}
      />
      <ClickUpCreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={selectedWorkspaceId}
        sourceContext={sourceContext}
        onCreated={(task) => {
          setTasks((current) => [task, ...current])
          setSelectedTask(task)
        }}
      />
    </div>
  )
}
