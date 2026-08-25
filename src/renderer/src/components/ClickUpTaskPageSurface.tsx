import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, ExternalLink, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { ClickUpTask, ClickUpTaskFilter, ClickUpWorkspaceSelection } from '../../../shared/clickup-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getLinkedWorkItemSuggestedName } from '../../../shared/workspace-name'
import { useAppStore } from '@/store'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { ClickUpApiTokenDialog } from '@/components/clickup-api-token-dialog'
import { ClickUpCreateTaskDialog } from '@/components/clickup-create-task-dialog'
import { ClickUpTaskDetailSheet } from '@/components/ClickUpTaskDetailSheet'
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
  clickUpTaskReference
} from './clickup-task-page-model'

const TASK_GRID_COLUMNS = 'grid-cols-[110px_minmax(0,2fr)_140px_140px_110px_64px]'

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
    let cancelled = false
    setLoading(true)
    setError(null)
    const shouldForce = refreshNonce !== forcedForNonceRef.current
    forcedForNonceRef.current = refreshNonce
    const request = appliedQuery.trim()
      ? searchTasks(appliedQuery, 50, { force: shouldForce, sourceContext })
      : listTasks(filter, 100, { force: shouldForce, sourceContext })
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
  }, [appliedQuery, filter, listTasks, refreshNonce, searchTasks, sourceContext, status.connected])

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks]
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
        <Select value={filter} onValueChange={(value) => setFilter(value as ClickUpTaskFilter)}>
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
        <form
          className="relative min-w-[220px] flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            setAppliedQuery(query.trim())
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              'auto.components.clickup.page.searchPlaceholder',
              'Search ClickUp tasks…'
            )}
            className="h-8 pl-8 pr-8"
          />
          {query || appliedQuery ? (
            <button
              type="button"
              aria-label={translate('auto.components.clickup.page.clearSearch', 'Clear search')}
              onClick={() => {
                setQuery('')
                setAppliedQuery('')
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </form>
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
        <div
          className={`grid ${TASK_GRID_COLUMNS} gap-3 border-b border-border bg-muted/35 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground`}
        >
          <span>{translate('auto.components.clickup.page.id', 'ID')}</span>
          <span>{translate('auto.components.clickup.page.name', 'Name')}</span>
          <span>{translate('auto.components.clickup.page.status', 'Status')}</span>
          <span>{translate('auto.components.clickup.page.list', 'List')}</span>
          <span>{translate('auto.components.clickup.page.updated', 'Updated')}</span>
          <span />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          {error ? (
            <div className="border-b border-border px-4 py-4 text-sm text-destructive">{error}</div>
          ) : null}
          {loading && tasks.length === 0 ? (
            <div className="divide-y divide-border">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className={`grid ${TASK_GRID_COLUMNS} gap-3 px-3 py-3`}>
                  {Array.from({ length: 5 }).map((__, cell) => (
                    <div key={cell} className="h-3 animate-pulse rounded bg-muted" />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
          {!loading && sortedTasks.length === 0 && !error ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate('auto.components.clickup.page.emptyTitle', 'No ClickUp tasks found')}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {translate(
                  'auto.components.clickup.page.emptyDescription',
                  'Try another filter or search term.'
                )}
              </p>
            </div>
          ) : null}
          <div className="divide-y divide-border">
            {sortedTasks.map((task) => (
              <div
                key={`${task.workspaceId}:${task.id}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedTask(task)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedTask(task)
                  }
                }}
                className={`grid ${TASK_GRID_COLUMNS} cursor-pointer gap-3 px-3 py-2 text-left hover:bg-accent`}
              >
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {clickUpTaskReference(task)}
                </span>
                <span className="truncate text-sm text-foreground">{task.name}</span>
                <span className="truncate text-xs text-muted-foreground">{task.status.name}</span>
                <span className="truncate text-xs text-muted-foreground">{task.list.name}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(task.updatedAt).toLocaleDateString()}
                </span>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleStartWorkspace(task)
                    }}
                  >
                    <ArrowRight />
                    <span className="sr-only">
                      {translate('auto.components.clickup.page.startWorkspace', 'Start workspace')}
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      void window.api.shell.openUrl(task.url)
                    }}
                  >
                    <ExternalLink />
                    <span className="sr-only">
                      {translate('auto.components.clickup.page.openTask', 'Open in ClickUp')}
                    </span>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
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
