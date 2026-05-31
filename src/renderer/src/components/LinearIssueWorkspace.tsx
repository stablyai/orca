/* eslint-disable max-lines -- Why: the Linear issue page co-locates the
   full-page layout with its hydration/comment state so the selected issue
   surface stays coherent with the existing Linear drawer behavior. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  FolderKanban,
  GitBranch,
  Link,
  LoaderCircle,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import { LinearIcon } from '@/components/icons/LinearIcon'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  initLinearIssueEditState,
  LinearIssueCommentFooter,
  LinearIssueEditSection,
  type LinearEditState,
  type LinearLocalComment
} from '@/components/LinearItemDrawer'
import { Button } from '@/components/ui/button'
import { LinearIssueTextEditor } from '@/components/LinearIssueTextEditor'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildLinearIssueContextSnapshot } from '@/lib/linear-issue-context-snapshot'
import { buildContainedLinkedContextBlock } from '@/lib/linked-work-item-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import {
  buildLinearIssueBranchName,
  formatLinearIssueRelativeTime
} from '@/components/linear-issue-workspace-text'
import {
  linearCreateSubIssue,
  linearGetIssue,
  linearIssueComments,
  linearListProjects,
  linearUpdateIssue
} from '@/runtime/runtime-linear-client'
import type {
  LinearComment,
  LinearIssue,
  LinearIssueChildSummary,
  LinearProjectSummary
} from '../../../shared/types'

type LinearIssueWorkspaceProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue, renderedText?: string) => void
  onOpenIssue: (issue: LinearIssue) => void
  onClose: () => void
  variant?: 'sheet' | 'page'
  backLabel?: string
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}`)
  }
}

function LinearIssueAvatar({
  avatarUrl,
  name,
  className = 'size-6'
}: {
  avatarUrl?: string
  name?: string
  className?: string
}): React.JSX.Element {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name ?? ''} className={`${className} shrink-0 rounded-full`} />
  }

  const initial = name?.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground`}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

function LinearIssueSubIssueButton({
  issue,
  onOpenIssue
}: {
  issue: LinearIssue
  onOpenIssue: (issue: LinearIssue) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [optimisticSubIssues, setOptimisticSubIssues] = useState<{
    issueId: string
    subIssues: LinearIssueChildSummary[]
  }>(() => ({
    issueId: issue.id,
    subIssues: []
  }))
  const [submitting, setSubmitting] = useState(false)
  const [openingSubIssueId, setOpeningSubIssueId] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  const subIssues = useMemo(() => {
    const baseSubIssues = issue.subIssues ?? []
    if (optimisticSubIssues.issueId !== issue.id || optimisticSubIssues.subIssues.length === 0) {
      return baseSubIssues
    }
    const baseIds = new Set(baseSubIssues.map((subIssue) => subIssue.id))
    const additions = optimisticSubIssues.subIssues.filter((subIssue) => !baseIds.has(subIssue.id))
    return additions.length === 0 ? baseSubIssues : [...baseSubIssues, ...additions]
  }, [issue.id, issue.subIssues, optimisticSubIssues])

  const handleOpenSubIssue = useCallback(
    async (subIssue: LinearIssueChildSummary) => {
      setOpeningSubIssueId(subIssue.id)
      try {
        const fullIssue = await fetchLinearIssue(subIssue.id, issue.workspaceId)
        if (!mountedRef.current) {
          return
        }
        if (fullIssue) {
          onOpenIssue(fullIssue)
        } else {
          toast.error('Failed to load sub-issue')
        }
      } catch (error) {
        if (mountedRef.current) {
          toast.error(error instanceof Error ? error.message : 'Failed to load sub-issue')
        }
      } finally {
        if (mountedRef.current) {
          setOpeningSubIssueId(null)
        }
      }
    },
    [fetchLinearIssue, issue.workspaceId, mountedRef, onOpenIssue]
  )

  const handleCreate = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const result = await linearCreateSubIssue(settings, {
        parentIssueId: issue.id,
        teamId: issue.team.id,
        title: trimmed,
        workspaceId: issue.workspaceId,
        projectId: issue.project?.id ?? null
      })
      if (result.ok) {
        const child = {
          id: result.id,
          identifier: result.identifier,
          title: result.title || trimmed,
          url: result.url
        }
        setOptimisticSubIssues((current) => {
          const currentSubIssues = current.issueId === issue.id ? current.subIssues : []
          if (
            currentSubIssues.some((subIssue) => subIssue.id === child.id) ||
            issue.subIssues?.some((subIssue) => subIssue.id === child.id)
          ) {
            return current
          }
          return { issueId: issue.id, subIssues: [...currentSubIssues, child] }
        })
        toast.success(`Created ${result.identifier}`)
        setTitle('')
        setOpen(false)
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create sub-issue')
    } finally {
      setSubmitting(false)
    }
  }, [
    issue.id,
    issue.project?.id,
    issue.subIssues,
    issue.team.id,
    issue.workspaceId,
    settings,
    title
  ])

  return (
    <section className="mt-10 max-w-[820px]">
      {subIssues.length > 0 ? (
        <div className="mb-3 space-y-1">
          {subIssues.map((subIssue) => (
            <button
              key={subIssue.id}
              type="button"
              onClick={() => void handleOpenSubIssue(subIssue)}
              disabled={openingSubIssueId !== null}
              className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="shrink-0 font-mono text-xs">{subIssue.identifier}</span>
              <span className="min-w-0 flex-1 truncate">{subIssue.title}</span>
              {openingSubIssueId === subIssue.id ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <ArrowRight className="size-3.5 shrink-0" />
              )}
            </button>
          ))}
        </div>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-9 items-center gap-2 rounded-md px-1 text-sm font-medium text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="size-4" />
            <span>Add sub-issues</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <div className="space-y-3">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder="Sub-issue title"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void handleCreate()}
                disabled={!title.trim() || submitting}
              >
                {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                Create
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </section>
  )
}

function LinearIssueSidebarProjectCard({
  issue,
  onProjectChanged
}: {
  issue: LinearIssue
  onProjectChanged: (project: LinearProjectSummary) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState<LinearProjectSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [savingProjectId, setSavingProjectId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    const timeout = window.setTimeout(() => {
      setLoading(true)
      void linearListProjects(settings, query, 20, issue.workspaceId)
        .then((result) => {
          if (!cancelled) {
            setProjects(result.items)
          }
        })
        .catch((error) => {
          if (!cancelled) {
            toast.error(error instanceof Error ? error.message : 'Failed to load projects')
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [issue.workspaceId, open, query, settings])

  const handleSelectProject = useCallback(
    async (project: LinearProjectSummary) => {
      setSavingProjectId(project.id)
      try {
        const result = await linearUpdateIssue(
          settings,
          issue.id,
          { projectId: project.id },
          issue.workspaceId
        )
        if (result.ok) {
          onProjectChanged(project)
          patchLinearIssue(issue.id, { project })
          toast.success('Project updated')
          setOpen(false)
        } else {
          toast.error(result.error)
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to update project')
      } finally {
        setSavingProjectId(null)
      }
    },
    [issue.id, issue.workspaceId, onProjectChanged, patchLinearIssue, settings]
  )

  return (
    <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
      <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
        <span>Project</span>
        <ChevronDown className="size-3.5" />
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="m-3 flex min-h-9 w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FolderKanban className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {issue.project?.name ?? 'Add to project'}
            </span>
            <ChevronDown className="size-3.5 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="start">
          <div className="space-y-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="max-h-64 overflow-y-auto scrollbar-sleek">
              {loading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Loading projects
                </div>
              ) : projects.length > 0 ? (
                projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => void handleSelectProject(project)}
                    disabled={savingProjectId !== null}
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-70"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full bg-muted"
                      style={project.color ? { backgroundColor: project.color } : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {savingProjectId === project.id ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : issue.project?.id === project.id ? (
                      <Check className="size-3.5" />
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  {query.trim() ? 'No projects found.' : 'Search for a project to add.'}
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </section>
  )
}

export default function LinearIssueWorkspace({
  issue,
  onUse,
  onOpenIssue,
  onClose,
  variant = 'sheet',
  backLabel = 'Back'
}: LinearIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const [fullIssue, setFullIssue] = useState<LinearIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [editState, setEditState] = useState<LinearEditState | null>(null)
  const requestIdRef = useRef(0)
  const hydratedIssueKeyRef = useRef<string | null>(null)
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const mountedRef = useMountedRef()

  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setFullIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    setEditState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const handleIssueTextChange = useCallback(
    (patch: Partial<Pick<LinearIssue, 'title' | 'description'>>) => {
      hasEditedRef.current = true
      setFullIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    },
    []
  )

  const loadComments = useCallback(
    async (targetIssue: LinearIssue, requestId: number): Promise<void> => {
      if (mountedRef.current) {
        setCommentsLoading(true)
        setCommentsError(null)
      }
      try {
        let fetched = (await linearIssueComments(
          settings,
          targetIssue.id,
          targetIssue.workspaceId
        )) as LinearComment[]
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [mountedRef, settings]
  )

  useEffect(() => {
    if (!issue) {
      hydratedIssueKeyRef.current = null
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsError(null)
      setEditState(null)
      hasEditedRef.current = false
      optimisticCommentsRef.current = []
      return
    }

    const issueKey = `${settings?.activeRuntimeEnvironmentId ?? 'local'}:${issue.workspaceId ?? 'selected'}:${issue.id}`
    if (hydratedIssueKeyRef.current === issueKey) {
      return
    }
    hydratedIssueKeyRef.current = issueKey

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    hasEditedRef.current = false
    optimisticCommentsRef.current = []
    setFullIssue(issue)
    setEditState(initLinearIssueEditState(issue))
    setComments([])
    setCommentsError(null)
    setIssueLoading(true)

    // Why: issue hydration and comments are separate surfaces; a comments
    // failure should not blank the issue detail the user selected.
    void linearGetIssue(settings, issue.id, issue.workspaceId)
      .then((issueResult) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        if (issueResult) {
          const fetched = issueResult as LinearIssue
          setFullIssue((prev) => {
            if (!hasEditedRef.current || !prev) {
              return fetched
            }
            // Why: late hydration can carry pre-edit field data; keep the
            // optimistic fields while accepting fresh non-field detail data.
            return {
              ...fetched,
              state: prev.state,
              title: prev.title,
              description: prev.description,
              priority: prev.priority,
              assignee: prev.assignee,
              estimate: prev.estimate,
              labelIds: prev.labelIds,
              labels: prev.labels
            }
          })
          if (!hasEditedRef.current) {
            setEditState(initLinearIssueEditState(fetched))
          }
        }
      })
      .catch(() => {
        /* The list issue remains useful if detail hydration is temporarily unavailable. */
      })
      .finally(() => {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void loadComments(issue, requestId)
  }, [issue, loadComments, mountedRef, settings])

  const displayed = fullIssue ?? issue

  const handleUseIssue = useCallback((): void => {
    if (!displayed) {
      return
    }
    onUse(displayed, buildLinearIssueContextSnapshot(displayed, comments))
  }, [comments, displayed, onUse])

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const newComment: LinearComment = {
      id: comment.id || createBrowserUuid(),
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: 'You' }
    }
    optimisticCommentsRef.current.push(newComment)
    setComments((prev) => [...prev, newComment])
  }, [])

  const handleProjectChanged = useCallback((project: LinearProjectSummary) => {
    setFullIssue((prev) => (prev ? { ...prev, project } : prev))
  }, [])

  const actionItems = useMemo(() => {
    if (!displayed) {
      return []
    }
    return [
      {
        label: 'Copy URL',
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.url, 'URL')
      },
      {
        label: 'Copy identifier',
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.identifier, 'Identifier')
      },
      {
        label: 'Copy suggested branch name',
        icon: GitBranch,
        action: () =>
          void copyTextToClipboard(buildLinearIssueBranchName(displayed), 'Suggested branch name')
      },
      {
        label: 'Copy prompt',
        icon: Clipboard,
        action: () => {
          const renderedText = buildLinearIssueContextSnapshot(displayed, comments)
          const prompt =
            buildContainedLinkedContextBlock({
              provider: 'linear',
              version: 1,
              renderedText
            }) ?? renderedText
          void copyTextToClipboard(prompt, 'Prompt')
        }
      }
    ]
  }, [comments, displayed])

  const content = displayed ? (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-border/60 px-5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          {variant === 'page' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="-ml-2 shrink-0 gap-1.5"
              aria-label={backLabel}
            >
              <ChevronLeft className="size-4" />
              {backLabel}
            </Button>
          ) : null}
          <LinearIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">
            {displayed.workspaceName ?? 'Linear'}
          </span>
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="shrink-0">Issues</span>
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="shrink-0 font-mono">{displayed.identifier}</span>
          <span className="min-w-0 truncate font-medium text-foreground">{displayed.title}</span>
          {issueLoading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden px-2 text-sm text-muted-foreground md:inline">2 / 17</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void copyTextToClipboard(displayed.url, 'URL')}
                aria-label="Copy Linear URL"
              >
                <Link className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Copy URL
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void copyTextToClipboard(displayed.identifier, 'Identifier')}
                aria-label="Copy issue identifier"
              >
                <Clipboard className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Copy identifier
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleUseIssue}
                aria-label="Start workspace from issue"
              >
                <ArrowRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Start workspace
            </TooltipContent>
          </Tooltip>
          {variant === 'sheet' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClose}
                  aria-label="Close Linear issue preview"
                >
                  <X className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Close
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="mx-auto grid w-full grid-cols-1 gap-10 px-7 py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:px-10 xl:px-12">
          <main className="min-w-0">
            <LinearIssueTextEditor issue={displayed} onIssueChange={handleIssueTextChange} />

            <LinearIssueSubIssueButton issue={displayed} onOpenIssue={onOpenIssue} />

            <section className="mt-12 border-t border-border/60 pt-9">
              <div className="mb-8 flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-foreground">Activity</h2>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <LinearIssueAvatar
                    avatarUrl={displayed.assignee?.avatarUrl}
                    name={displayed.assignee?.displayName}
                    className="size-6"
                  />
                </div>
              </div>

              <div className="mb-7 flex items-center gap-3 text-sm text-muted-foreground">
                <LinearIssueAvatar
                  avatarUrl={displayed.assignee?.avatarUrl}
                  name={displayed.assignee?.displayName}
                  className="size-5"
                />
                <span>
                  {displayed.assignee?.displayName ?? 'Someone'} updated the issue ·{' '}
                  {formatLinearIssueRelativeTime(displayed.updatedAt)}
                </span>
              </div>

              {commentsError ? (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <span>{commentsError}</span>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void loadComments(displayed, requestIdRef.current)}
                    disabled={commentsLoading}
                    className="gap-1"
                  >
                    {commentsLoading ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    Retry
                  </Button>
                </div>
              ) : null}

              {commentsLoading && comments.length === 0 ? (
                <div className="mb-5 flex items-center justify-center py-8">
                  <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : comments.length > 0 ? (
                <div className="mb-6 flex flex-col gap-5">
                  {comments.map((comment) => (
                    <article key={comment.id} className="flex gap-3">
                      <LinearIssueAvatar
                        avatarUrl={comment.user?.avatarUrl}
                        name={comment.user?.displayName}
                        className="size-7"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex min-w-0 items-center gap-2 text-sm">
                          <span className="truncate font-semibold text-foreground">
                            {comment.user?.displayName ?? 'Unknown'}
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            {formatLinearIssueRelativeTime(comment.createdAt)}
                          </span>
                        </div>
                        <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
                          <CommentMarkdown
                            content={comment.body}
                            className="text-[14px] leading-7"
                          />
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}

              <LinearIssueCommentFooter
                issueId={displayed.id}
                workspaceId={displayed.workspaceId}
                onCommentAdded={handleCommentAdded}
                variant="linear-page"
              />
            </section>
          </main>

          <aside className="space-y-3 lg:sticky lg:top-6 lg:self-start">
            {editState ? (
              <LinearIssueEditSection
                issue={displayed}
                editState={editState}
                onEditStateChange={handleEditStateChange}
                layout="properties"
              />
            ) : null}
            <LinearIssueSidebarProjectCard
              issue={displayed}
              onProjectChanged={handleProjectChanged}
            />
            <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
              <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
                <span>Actions</span>
                <ChevronDown className="size-3.5" />
              </div>
              <div className="space-y-1 p-3">
                {actionItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <Tooltip key={item.label}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={item.action}
                          className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" sideOffset={6}>
                        {item.label}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  ) : null

  if (variant === 'page') {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
        {content}
      </div>
    )
  }

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,1180px)] bg-background p-0 sm:max-w-[1180px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'Linear issue'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            Preview, edit, and start work from the selected issue.
          </SheetDescription>
        </VisuallyHidden.Root>

        {content}
      </SheetContent>
    </Sheet>
  )
}
