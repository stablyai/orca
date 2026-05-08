/* Why: minimal v1 of the GitLab counterpart to GitHubItemDialog.
   Renders an MR or issue's title, state, author, and body in a side
   sheet. Comments, files, pipeline jobs, and edit affordances are
   v1.5 — those mirror substantial GitHub-side surface area and are
   not worth porting until the basic preview proves useful. */
import React, { useEffect, useState } from 'react'
import { ExternalLink, GitPullRequest, CircleDot, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { VisuallyHidden } from 'radix-ui'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import type { GitLabWorkItem } from '../../../shared/types'

type GitLabItemDetail = {
  /** Full description body (`description` in GitLab API). May be empty. */
  description: string
  authorUsername: string | null
  authorAvatarUrl: string | null
}

type Props = {
  /** When non-null the sheet is open; null closes it. */
  item: GitLabWorkItem | null
  repoPath: string | null
  onClose: () => void
  /** Optional — wired by callers that want a "Create workspace from this"
   *  affordance in the sheet footer. v1 omits it; the SmartWorkspaceNameField
   *  paste-URL flow already covers the same use case. */
  onCreateWorkspace?: (item: GitLabWorkItem) => void
}

// Why: GitLab API state values map onto a coarser visual palette than
// GitHub's. Keep the styling local — there's no benefit to coupling
// this to the GitHub PR/issue palette since the verbs differ ('opened'
// vs 'open', 'merged' as a terminal not active state).
const STATE_TONE: Record<GitLabWorkItem['state'], string> = {
  opened: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  closed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  merged: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  // Why: locked is rare and visually similar to closed; reuse rose tone.
  locked: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  draft: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
}

function StateBadge({ state }: { state: GitLabWorkItem['state'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        STATE_TONE[state]
      )}
    >
      {state}
    </span>
  )
}

export default function GitLabItemDialog({
  item,
  repoPath,
  onClose,
  onCreateWorkspace
}: Props): React.JSX.Element {
  const [detail, setDetail] = useState<GitLabItemDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!item || !repoPath) {
      setDetail(null)
      setLoading(false)
      setError(null)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    // Why: the list-endpoint payload omits the description. Fetch the
    // detail endpoint (gl.mr or gl.issue) when the sheet opens so the
    // body renders. The IPC handlers already accept the same project-
    // ref-resolved repoPath we use everywhere.
    const promise =
      item.type === 'mr'
        ? window.api.gl.mr({ repoPath, iid: item.number })
        : window.api.gl.issue({ repoPath, number: item.number })
    void promise
      .then((data) => {
        if (stale) {
          return
        }
        if (!data) {
          setError('Item not found.')
          return
        }
        // Why: detail-endpoint mappers populate description / author /
        // authorAvatarUrl on MRInfo and GitLabIssueInfo. Read them
        // directly — the cast narrows the union type without forcing
        // a runtime guard since both sides expose the same optional
        // fields.
        const info = data as {
          description?: string
          author?: string | null
          authorAvatarUrl?: string | null
        }
        setDetail({
          description: info.description ?? '',
          authorUsername: info.author ?? item.author,
          authorAvatarUrl: info.authorAvatarUrl ?? null
        })
      })
      .catch((err) => {
        if (!stale) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [item, repoPath])

  const Icon = item?.type === 'mr' ? GitPullRequest : CircleDot
  const prefix = item?.type === 'mr' ? '!' : '#'

  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        {/* Why: hidden title for screen readers — the visible header below
            uses custom layout that doesn't fit the SheetTitle slot. */}
        <VisuallyHidden.Root>
          <SheetTitle>{item ? item.title : 'Work item'}</SheetTitle>
          <SheetDescription>GitLab work item detail</SheetDescription>
        </VisuallyHidden.Root>

        {item ? (
          <>
            <header className="flex-none border-b border-border/40 px-5 py-4">
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {prefix}
                      {item.number}
                    </span>
                    <StateBadge state={item.state} />
                    {detail?.authorUsername ? (
                      <span>by {detail.authorUsername}</span>
                    ) : item.author ? (
                      <span>by {item.author}</span>
                    ) : null}
                  </div>
                  <h2 className="mt-1.5 text-lg font-semibold leading-tight text-foreground">
                    {item.title}
                  </h2>
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : detail?.description ? (
                <CommentMarkdown content={detail.description} />
              ) : (
                <p className="text-sm text-muted-foreground">No description.</p>
              )}
            </div>

            <footer className="flex-none border-t border-border/40 px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.api.shell.openUrl(item.url)}
                  className="gap-1.5"
                >
                  <ExternalLink className="size-3.5" />
                  Open in browser
                </Button>
                {onCreateWorkspace ? (
                  <Button size="sm" onClick={() => onCreateWorkspace(item)}>
                    Create workspace
                  </Button>
                ) : null}
              </div>
            </footer>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
