import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, GitPullRequest, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import type { GiteaWorkItem, GiteaWorkItemFilter, Repo } from '../../../shared/types'
import type { GiteaIssueScope } from '@/store/slices/gitea'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { GiteaNewIssueDialog } from '@/components/gitea-new-issue-dialog'
import { translate } from '@/i18n/i18n'

type GiteaTypeFilter = 'all' | 'issue' | 'pull'

type GiteaTaskListProps = {
  repos: Repo[]
  makeScope: (repo: Repo) => GiteaIssueScope
  onOpen: (repo: Repo, item: GiteaWorkItem) => void
  projectPicker?: React.ReactNode
}

type Row = { repo: Repo; item: GiteaWorkItem }

function getFilterPresets(): { id: GiteaWorkItemFilter; label: string }[] {
  return [
    { id: 'all', label: translate('auto.components.GiteaTaskList.c07dd13940', 'All open') },
    {
      id: 'assigned',
      label: translate('auto.components.GiteaTaskList.ab2a229e50', 'Assigned to me')
    },
    { id: 'created', label: translate('auto.components.GiteaTaskList.74f30cd767', 'Created') },
    { id: 'closed', label: translate('auto.components.GiteaTaskList.031c70d963', 'Closed') }
  ]
}

function getTypeFilters(): { id: GiteaTypeFilter; label: string }[] {
  return [
    { id: 'all', label: translate('auto.components.GiteaTaskList.bf66fad935', 'All') },
    { id: 'issue', label: translate('auto.components.GiteaTaskList.65a3bffe7a', 'Issues') },
    { id: 'pull', label: translate('auto.components.GiteaTaskList.9b21aab4c9', 'PRs') }
  ]
}

function stateLabel(item: GiteaWorkItem): string {
  if (item.type === 'pull') {
    if (item.state === 'merged') {
      return translate('auto.components.GiteaTaskList.9986e0e679', 'Merged')
    }
    if (item.draft) {
      return translate('auto.components.GiteaTaskList.747423c0f8', 'Draft')
    }
  }
  return item.state === 'closed'
    ? translate('auto.components.GiteaTaskList.031c70d963', 'Closed')
    : translate('auto.components.GiteaTaskList.980519b0c8', 'Open')
}

// Self-contained Tasks-page panel for the Gitea source: fetches unified work
// items (issues + pull requests) for the selected repos with GitHub-style
// filters (incl. assigned-to-me) and an issue/PR toggle, and lets the user
// start a workspace from any of them. Kept out of TaskPage.tsx to avoid growth.
export function GiteaTaskList({
  repos,
  makeScope,
  onOpen,
  projectPicker
}: GiteaTaskListProps): React.JSX.Element {
  const fetchGiteaWorkItems = useAppStore((s) => s.fetchGiteaWorkItems)
  const createGiteaIssue = useAppStore((s) => s.createGiteaIssue)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<GiteaWorkItemFilter>('all')
  const [typeFilter, setTypeFilter] = useState<GiteaTypeFilter>('all')
  const [nonce, setNonce] = useState(0)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const loadSeqRef = useRef(0)

  // New issues target the first selected project (narrow the picker to choose).
  const newIssueRepo = repos[0] ?? null

  const load = useCallback(async () => {
    // Why: ignore stale responses so an older load can't overwrite newer state.
    const seq = ++loadSeqRef.current
    if (repos.length === 0) {
      setRows([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const results = await Promise.all(
        repos.map(async (repo) => {
          const items = await fetchGiteaWorkItems(makeScope(repo), filter)
          return items.map((item) => ({ repo, item }))
        })
      )
      if (seq !== loadSeqRef.current) {
        return
      }
      setRows(results.flat())
    } catch {
      if (seq !== loadSeqRef.current) {
        return
      }
      setError(translate('auto.components.GiteaTaskList.0285721e62', 'Failed to load Gitea tasks.'))
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false)
      }
    }
  }, [repos, makeScope, fetchGiteaWorkItems, filter])

  useEffect(() => {
    void load()
  }, [load, nonce])

  const visibleRows = useMemo(
    () => (typeFilter === 'all' ? rows : rows.filter(({ item }) => item.type === typeFilter)),
    [rows, typeFilter]
  )

  const handleCreateIssue = useCallback(
    async (title: string, body: string): Promise<boolean> => {
      if (!newIssueRepo) {
        return false
      }
      const result = await createGiteaIssue(makeScope(newIssueRepo), { title, body })
      if (result.ok) {
        setNonce((n) => n + 1)
        return true
      }
      return false
    },
    [createGiteaIssue, makeScope, newIssueRepo]
  )

  return (
    <div className="flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <div className="flex min-w-0 flex-col gap-2 border-b border-border/50 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-1 text-xs">
            {getTypeFilters().map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTypeFilter(id)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs transition',
                  typeFilter === id
                    ? 'border-foreground/40 bg-foreground/90 text-background'
                    : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {projectPicker ? (
            <div className="min-w-0 flex-1">{projectPicker}</div>
          ) : (
            <div className="flex-1" />
          )}
          {newIssueRepo ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewIssueOpen(true)}
              className="shrink-0 gap-1.5 border-border/50 bg-transparent hover:bg-muted/50"
            >
              <Plus className="size-4" />
              {translate('auto.components.GiteaTaskList.5997067bee', 'New issue')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            onClick={() => setNonce((n) => n + 1)}
            disabled={loading}
            aria-label={translate(
              'auto.components.GiteaTaskList.e3db16e7c7',
              'Refresh Gitea tasks'
            )}
            className="size-8 shrink-0 border-border/50 bg-transparent hover:bg-muted/50"
          >
            {loading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {getFilterPresets().map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs transition',
                filter === id
                  ? 'border-border/50 bg-foreground/90 text-background'
                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        {error ? (
          <div className="px-4 py-4 text-sm text-destructive">{error}</div>
        ) : repos.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {translate(
              'auto.components.GiteaTaskList.34cd2d1024',
              'Select a Gitea-hosted project to see its issues and pull requests.'
            )}
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {translate('auto.components.GiteaTaskList.6e1e6691d7', 'Loading Gitea tasks…')}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {translate(
              'auto.components.GiteaTaskList.00f67933b5',
              'No matching issues or pull requests.'
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {visibleRows.map(({ repo, item }) => (
              <button
                key={`${repo.id}:${item.type}:${item.number}`}
                type="button"
                onClick={() => onOpen(repo, item)}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  {item.type === 'pull' ? (
                    <GitPullRequest className="size-4" />
                  ) : (
                    <CircleDot className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="truncate text-sm font-medium text-foreground">{item.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">#{item.number}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium',
                        item.state === 'open'
                          ? 'bg-status-success/15 text-status-success'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {stateLabel(item)}
                    </span>
                    {repos.length > 1 ? <span className="truncate">{repo.displayName}</span> : null}
                    {item.labels.slice(0, 3).map((label) => (
                      <span key={label} className="truncate rounded bg-muted px-1.5 py-0.5">
                        {label}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {newIssueRepo ? (
        <GiteaNewIssueDialog
          open={newIssueOpen}
          onOpenChange={setNewIssueOpen}
          repoName={newIssueRepo.displayName}
          onCreate={handleCreateIssue}
        />
      ) : null}
    </div>
  )
}
