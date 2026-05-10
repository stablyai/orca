/* eslint-disable max-lines -- Why: the GH item dialog keeps its header, conversation, files, and checks tabs co-located so the read-only PR/Issue surface stays in one place while this view evolves. */
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignJustify,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GitPullRequest,
  LayoutList,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Send,
  UndoDot,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { VisuallyHidden } from 'radix-ui'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import { buildDiffTree, type DiffTreeNode } from '@/components/pr-diff-tree'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-helpers'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  getPRCommentAudienceEmptyLabel,
  PR_COMMENT_AUDIENCE_FILTERS,
  type PRCommentAudienceFilter
} from '@/lib/pr-comment-audience'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  isResolvedPRCommentGroup,
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS,
  type PRCommentGroup
} from '@/lib/pr-comment-groups'
import { useAppStore } from '@/store'
import { useRepoLabels, useRepoAssignees, useImmediateMutation } from '@/hooks/useIssueMetadata'
import { useRepoLabelsBySlug, useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import IssueSourceIndicator, { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import type {
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubAssignableUser,
  GitHubReaction,
  PRComment
} from '../../../shared/types'
import { PER_REPO_FETCH_LIMIT } from '../../../shared/work-items'

// Why: the GH item dialog can be opened from any work-item list surface and
// doesn't have the full owner/repo context the list's cache entry carries.
// Parsing the canonical `https://github.com/{owner}/{repo}/...` URL is the
// simplest reliable source — the URL is already present on every work item
// and survives the main-process → IPC boundary. Non-GitHub hosts return null,
// which matches the indicator's suppression rule.
function parseOwnerRepoFromItemUrl(url: string): GitHubOwnerRepo | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') {
      return null
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      return null
    }
    return { owner: segments[0], repo: segments[1] }
  } catch {
    return null
  }
}

// Why: the editor's DiffViewer loads Monaco, which is heavy and should not be
// pulled into the dialog's bundle until the user actually opens the Files tab.
const DiffViewer = lazy(() => import('@/components/editor/DiffViewer'))
const MonacoCodeExcerpt = lazy(() => import('@/components/editor/MonacoCodeExcerpt'))

type ItemDialogTab = 'conversation' | 'files'

type MentionOption = {
  login: string
  name?: string | null
  avatarUrl?: string
  source: string
}

type MentionQuery = {
  atIndex: number
  query: string
}

const CODE_CONTEXT_EXPAND_STEP = 5
const CODE_CONTEXT_FALLBACK_LINES = 20
const CODE_CONTEXT_MAX_BLOCK_LINES = CODE_CONTEXT_FALLBACK_LINES * 2 + 1

const REACTION_EMOJI: Record<GitHubReaction['content'], string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  confused: '😕',
  heart: '❤️',
  hooray: '🎉',
  rocket: '🚀',
  eyes: '👀'
}

/** Why: Project-origin rows don't always belong to the active local repo.
 *  When set, GHEditSection routes label/assignee/state mutations through
 *  slug-addressed IPCs against `owner`/`repo` instead of through `repoPath`,
 *  preventing edits from silently landing on the workspace's repo when the
 *  Project view is showing rows from a different repo. See
 *  docs/design/github-project-view-tasks.md §Dialog editing from Project rows.
 */
export type GitHubItemDialogProjectOrigin = {
  owner: string
  repo: string
  number: number
  type: 'issue' | 'pr'
  projectId: string
  projectItemId: string
  cacheKey: string
}

type GitHubItemDialogProps = {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  /** Called when the user clicks the primary CTA to start work from this item. */
  onUse: (item: GitHubWorkItem) => void
  onClose: () => void
  /** Optional Project-origin context. When set, edits in the dialog are
   *  routed via slug-addressed mutation IPCs against the row's actual repo
   *  instead of the active workspace's `repoPath`. Both can be set
   *  simultaneously (Project mode where the row also lives in the active
   *  workspace) — slug routing wins for writes. */
  projectOrigin?: GitHubItemDialogProjectOrigin
}

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMs = date.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }
  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(^|[\s([{,])@([A-Za-z0-9-]*)$/.exec(beforeCaret)
  if (!match) {
    return null
  }
  const query = match[2] ?? ''
  return {
    atIndex: beforeCaret.length - query.length - 1,
    query
  }
}

function buildMentionOptions({
  item,
  comments,
  participants,
  assignableUsers
}: {
  item: GitHubWorkItem
  comments: PRComment[]
  participants: GitHubAssignableUser[]
  assignableUsers: GitHubAssignableUser[]
}): MentionOption[] {
  const byLogin = new Map<string, MentionOption>()
  const add = (
    login: string | null | undefined,
    source: string,
    avatarUrl?: string,
    name?: string | null
  ): void => {
    if (!login || login === 'ghost') {
      return
    }
    const key = login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      if (!existing.avatarUrl && avatarUrl) {
        existing.avatarUrl = avatarUrl
      }
      if (!existing.name && name) {
        existing.name = name
      }
      return
    }
    byLogin.set(key, { login, source, avatarUrl, name })
  }

  add(item.author, item.type === 'pr' ? 'PR author' : 'Issue author')
  for (const comment of comments) {
    add(comment.author, 'Commenter', comment.authorAvatarUrl)
  }
  for (const user of participants) {
    add(user.login, 'Participant', user.avatarUrl, user.name)
  }
  for (const user of assignableUsers) {
    add(user.login, 'Team member', user.avatarUrl, user.name)
  }

  return Array.from(byLogin.values())
}

function filterMentionOptions(options: MentionOption[], query: string): MentionOption[] {
  const normalizedQuery = query.toLowerCase()
  const filtered = normalizedQuery
    ? options.filter(
        (option) =>
          option.login.toLowerCase().includes(normalizedQuery) ||
          (option.name ?? '').toLowerCase().includes(normalizedQuery)
      )
    : options
  return filtered.slice(0, 8)
}

function getStateLabel(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'Merged'
    }
    if (item.state === 'draft') {
      return 'Draft'
    }
    if (item.state === 'closed') {
      return 'Closed'
    }
    return 'Open'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

function getStateTone(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
    }
    if (item.state === 'draft') {
      return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    }
    if (item.state === 'closed') {
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
    }
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  }
  if (item.state === 'closed') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
  }
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
}

function fileStatusTone(status: GitHubPRFile['status']): string {
  switch (status) {
    case 'added':
      return 'text-emerald-500'
    case 'removed':
      return 'text-rose-500'
    case 'renamed':
    case 'copied':
      return 'text-sky-500'
    default:
      return 'text-amber-500'
  }
}

function fileStatusLabel(status: GitHubPRFile['status']): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'removed':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'unchanged':
      return '·'
    default:
      return 'M'
  }
}

function findNearestBraceBlock(
  lines: string[],
  targetLine: number
): { startLine: number; endLine: number } | null {
  const stack: number[] = []
  const ranges: { startLine: number; endLine: number }[] = []
  const targetIndex = targetLine - 1

  lines.forEach((line, lineIndex) => {
    for (const character of line) {
      if (character === '{') {
        stack.push(lineIndex)
      } else if (character === '}') {
        const startLine = stack.pop()
        if (startLine !== undefined && startLine <= lineIndex) {
          ranges.push({ startLine: startLine + 1, endLine: lineIndex + 1 })
        }
      }
    }
  })

  const containingRange = ranges
    .filter((range) => range.startLine - 1 <= targetIndex && targetIndex <= range.endLine - 1)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]

  if (containingRange) {
    return containingRange
  }

  return (
    ranges
      .filter(
        (range) => range.startLine - 1 >= targetIndex && range.startLine - 1 - targetIndex <= 8
      )
      .sort((a, b) => a.startLine - b.startLine)[0] ?? null
  )
}

type FileRowProps = {
  file: GitHubPRFile
  repoPath: string
  prNumber: number
  headSha: string | undefined
  baseSha: string | undefined
}

type DiffViewMode = 'flat' | 'tree'

// ─── Tree view components ────────────────────────────────────────────

type DiffTreeNodeProps = {
  node: DiffTreeNode
  depth: number
  repoPath: string
  prNumber: number
  headSha: string | undefined
  baseSha: string | undefined
  onCommentAdded: (comment: PRComment) => void
}

function PRDiffTreeNode({
  node,
  depth,
  repoPath,
  prNumber,
  headSha,
  baseSha,
  onCommentAdded
}: DiffTreeNodeProps): React.JSX.Element {
  const [open, setOpen] = useState(true)

  if (node.kind === 'file') {
    return (
      <PRFileRow
        file={node.file}
        repoPath={repoPath}
        prNumber={prNumber}
        headSha={headSha}
        baseSha={baseSha}
        onCommentAdded={onCommentAdded}
        // Why: tree-view file rows are indented by a CSS left-padding proportional
        // to depth so the expand chevron of PRFileRow stays at position 0 while
        // the folder hierarchy is communicated purely through indentation.
        indentDepth={depth}
        label={node.name}
      />
    )
  }

  // Directory node
  return (
    <div role="treeitem" aria-expanded={open}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition hover:bg-muted/40"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        aria-label={`${open ? 'Collapse' : 'Expand'} folder ${node.name}`}
      >
        {open ? (
          <>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            <FolderOpen className="size-3.5 shrink-0 text-amber-400" />
          </>
        ) : (
          <>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            <Folder className="size-3.5 shrink-0 text-amber-400" />
          </>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {node.name}
        </span>
      </button>
      {open && (
        <div role="group">
          {node.children.map((child) => (
            <PRDiffTreeNode
              key={child.kind === 'file' ? child.file.path : child.path}
              node={child}
              depth={depth + 1}
              repoPath={repoPath}
              prNumber={prNumber}
              headSha={headSha}
              baseSha={baseSha}
              onCommentAdded={onCommentAdded}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type PRDiffTreeViewProps = {
  files: GitHubPRFile[]
  repoPath: string
  prNumber: number
  headSha: string | undefined
  baseSha: string | undefined
  onCommentAdded: (comment: PRComment) => void
}

function PRDiffTreeView({
  files,
  repoPath,
  prNumber,
  headSha,
  baseSha,
  onCommentAdded
}: PRDiffTreeViewProps): React.JSX.Element {
  const tree = useMemo(() => buildDiffTree(files), [files])
  return (
    <div role="tree" aria-label="Changed files">
      {tree.map((node) => (
        <PRDiffTreeNode
          key={node.kind === 'file' ? node.file.path : node.path}
          node={node}
          depth={0}
          repoPath={repoPath}
          prNumber={prNumber}
          headSha={headSha}
          baseSha={baseSha}
          onCommentAdded={onCommentAdded}
        />
      ))}
    </div>
  )
}

// Why: SWR cache for the work-item details fetch. Reopening the same drawer
// pays full IPC + `gh` process startup latency without this; with it, cached
// data paints immediately while a background refetch keeps the view honest.
// Cache is keyed by repoPath + issueSourcePreference + type + number so
// upstream/origin source toggles and issue#N vs pr#N never collide. Bounded
// to ~50 entries to cap memory; entries older than FRESH_MS trigger a
// background refetch on open. See docs/gh-work-item-drawer-cache.md.
const WORK_ITEM_DETAILS_CACHE_MAX = 50
const WORK_ITEM_DETAILS_FRESH_MS = 30_000
type WorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  fetchedAt: number
  pending?: Promise<GitHubWorkItemDetails | null>
  error?: string
}
const workItemDetailsCache = new Map<string, WorkItemDetailsCacheEntry>()

function getWorkItemDetailsCacheKey(args: {
  repoPath: string
  issueSourcePreference: string | undefined
  type: 'issue' | 'pr'
  number: number
}): string {
  // Why: include all axes that change which (repo, item) the IPC resolves to.
  // `\0` separator avoids ambiguity between fields that may contain `:` or `/`.
  return [args.repoPath, args.issueSourcePreference ?? 'auto', args.type, args.number].join('\0')
}

function touchWorkItemDetailsCache(key: string, entry: WorkItemDetailsCacheEntry): void {
  // Why: re-insert to move to MRU position; Map preserves insertion order so
  // the oldest key is always first when evicting.
  workItemDetailsCache.delete(key)
  workItemDetailsCache.set(key, entry)
  while (workItemDetailsCache.size > WORK_ITEM_DETAILS_CACHE_MAX) {
    const oldest = workItemDetailsCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    workItemDetailsCache.delete(oldest)
  }
}

// Why: exposed so mutation handlers (in this file and elsewhere) can drop a
// stale entry after a successful local mutation. Cross-window invalidation
// arrives via the `gh:workItemMutated` event listener installed below.
export function invalidateWorkItemDetailsCacheForKey(key: string): void {
  workItemDetailsCache.delete(key)
}

// Why: monotonically increases on every invalidation so an in-flight refetch
// that started before a mutation can detect that its result is stale and
// must not be written back. Without this, a mutation that lands while a
// refetch is in flight would have its invalidation silently undone when the
// stale promise resolves and re-populates the entry.
let workItemDetailsCacheGeneration = 0

// Why: when we don't have the exact cache key (e.g. an event from another
// window only carries repoPath + number + type), drop every entry that
// matches the (repoPath, type, number) tuple regardless of source preference.
function invalidateWorkItemDetailsCacheByMatch(args: {
  repoPath: string
  type: 'issue' | 'pr'
  number: number
}): void {
  workItemDetailsCacheGeneration += 1
  const suffix = `\0${args.type}\0${args.number}`
  const prefix = `${args.repoPath}\0`
  for (const key of Array.from(workItemDetailsCache.keys())) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      workItemDetailsCache.delete(key)
    }
  }
}

// Why: install once at module load — every dialog instance shares the cache,
// so a single subscription is enough. The preload bridge re-emits the
// main-process broadcast for every window, so each renderer invalidates its
// own cache when any window's mutation lands. We track the unsubscribe so
// Vite HMR doesn't accumulate listeners across module reloads in dev.
let workItemMutatedUnsub: (() => void) | undefined
if (typeof window !== 'undefined' && window.api?.gh?.onWorkItemMutated) {
  workItemMutatedUnsub = window.api.gh.onWorkItemMutated((payload) => {
    invalidateWorkItemDetailsCacheByMatch({
      repoPath: payload.repoPath,
      type: payload.type,
      number: payload.number
    })
  })
}
if (typeof import.meta !== 'undefined' && import.meta.hot) {
  import.meta.hot.dispose(() => {
    workItemMutatedUnsub?.()
  })
}

// Why: bounded LRU — opening many PRs with many files during a session
// would otherwise grow this module-level map without bound until reload.
const PR_FILE_CONTENT_CACHE_MAX = 64
const prFileContentCache = new Map<string, Promise<GitHubPRFileContents> | GitHubPRFileContents>()

function touchPRFileContentCache(
  key: string,
  value: Promise<GitHubPRFileContents> | GitHubPRFileContents
): void {
  // Why: re-insert to move to the most-recently-used position; Map preserves
  // insertion order so the oldest key is always first when evicting.
  prFileContentCache.delete(key)
  prFileContentCache.set(key, value)
  while (prFileContentCache.size > PR_FILE_CONTENT_CACHE_MAX) {
    const oldest = prFileContentCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    prFileContentCache.delete(oldest)
  }
}

function getPRFileContentCacheKey(args: {
  repoPath: string
  prNumber: number
  file: GitHubPRFile
  headSha: string
  baseSha: string
}): string {
  return [
    args.repoPath,
    args.prNumber,
    args.file.path,
    args.file.oldPath ?? '',
    args.file.status,
    args.headSha,
    args.baseSha
  ].join('\0')
}

function loadPRFileContents(args: {
  repoPath: string
  prNumber: number
  file: GitHubPRFile
  headSha: string
  baseSha: string
}): Promise<GitHubPRFileContents> {
  const cacheKey = getPRFileContentCacheKey(args)
  const cached = prFileContentCache.get(cacheKey)
  if (cached) {
    touchPRFileContentCache(cacheKey, cached)
    return Promise.resolve(cached)
  }
  const request = window.api.gh
    .prFileContents({
      repoPath: args.repoPath,
      prNumber: args.prNumber,
      path: args.file.path,
      oldPath: args.file.oldPath,
      status: args.file.status,
      headSha: args.headSha,
      baseSha: args.baseSha
    })
    .then((contents) => {
      touchPRFileContentCache(cacheKey, contents)
      return contents
    })
    .catch((err) => {
      prFileContentCache.delete(cacheKey)
      throw err
    })
  touchPRFileContentCache(cacheKey, request)
  return request
}

function PRFileRow({
  file,
  repoPath,
  prNumber,
  headSha,
  baseSha,
  onCommentAdded,
  indentDepth = 0,
  label
}: FileRowProps & {
  onCommentAdded: (comment: PRComment) => void
  indentDepth?: number
  label?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [contents, setContents] = useState<GitHubPRFileContents | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canLoadDiff = Boolean(headSha && baseSha) && !file.isBinary

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      if (next && !contents && !loading && canLoadDiff && headSha && baseSha) {
        setLoading(true)
        setError(null)
        loadPRFileContents({
          repoPath,
          prNumber,
          file,
          headSha,
          baseSha
        })
          .then((result) => {
            setContents(result)
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : 'Failed to load diff')
          })
          .finally(() => {
            setLoading(false)
          })
      }
      return next
    })
  }, [baseSha, canLoadDiff, contents, file, headSha, loading, prNumber, repoPath])

  const language = useMemo(() => detectLanguage(file.path), [file.path])
  const modelKey = `gh-dialog:pr:${prNumber}:${file.path}`
  const handleAddLineComment = useCallback(
    async ({
      lineNumber,
      startLine,
      body: commentBody
    }: {
      lineNumber: number
      startLine?: number
      body: string
    }) => {
      if (!headSha) {
        toast.error('Unable to comment without the PR head SHA.')
        return false
      }
      const result = await window.api.gh.addPRReviewComment({
        repoPath,
        prNumber,
        commitId: headSha,
        path: file.path,
        line: lineNumber,
        startLine,
        body: commentBody
      })
      if (!result.ok) {
        toast.error(result.error || 'Failed to add review comment.')
        return false
      }
      onCommentAdded(result.comment)
      toast.success('Review comment added.')
      return true
    },
    [file.path, headSha, onCommentAdded, prNumber, repoPath]
  )

  return (
    <div className="border-b border-border/50" {...(label != null ? { role: 'treeitem' } : {})}>
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-2 pr-3 text-left transition hover:bg-muted/40"
        style={{ paddingLeft: `${12 + indentDepth * 16}px` }}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded border border-border/60 font-mono text-[10px]',
            fileStatusTone(file.status)
          )}
          aria-label={file.status}
        >
          {fileStatusLabel(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
          {file.oldPath && file.oldPath !== file.path ? (
            label ? (
              // Why: in tree view we only have room for basenames, but still need to
              // communicate the rename so the user doesn't have to expand or switch
              // to flat view to discover what was renamed. When basenames match (i.e.
              // only the directory changed), we include the parent directory so the
              // display isn't a meaningless "foo.ts → foo.ts".
              (() => {
                const oldBase = file.oldPath!.split('/').pop() ?? file.oldPath!
                if (oldBase === label) {
                  const oldParts = file.oldPath!.split('/')
                  const newParts = file.path.split('/')
                  const oldShort = oldParts.slice(-2).join('/')
                  const newShort = newParts.slice(-2).join('/')
                  return (
                    <>
                      <span className="text-muted-foreground">{oldShort}</span>
                      <span className="mx-1 text-muted-foreground">→</span>
                      {newShort}
                    </>
                  )
                }
                return (
                  <>
                    <span className="text-muted-foreground">{oldBase}</span>
                    <span className="mx-1 text-muted-foreground">→</span>
                    {label}
                  </>
                )
              })()
            ) : (
              <>
                <span className="text-muted-foreground">{file.oldPath}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                {file.path}
              </>
            )
          ) : (
            (label ?? file.path)
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          <span className="text-emerald-500">+{file.additions}</span>
          <span className="mx-1">/</span>
          <span className="text-rose-500">−{file.deletions}</span>
        </span>
      </button>

      {expanded && (
        // Why: DiffViewer's inner layout uses flex-1/min-h-0, so this wrapper
        // must be a flex column with a fixed height for Monaco to size itself
        // correctly. A plain block div collapses flex-1 to 0 and renders empty.
        <div className="flex h-[420px] flex-col border-t border-border/40 bg-background">
          {!canLoadDiff ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
              {file.isBinary
                ? 'Binary file — diff not shown.'
                : 'Diff unavailable (missing commit SHAs).'}
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-destructive">
              {error}
            </div>
          ) : contents ? (
            contents.originalIsBinary || contents.modifiedIsBinary ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
                Binary file — diff not shown.
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  </div>
                }
              >
                <DiffViewer
                  modelKey={modelKey}
                  originalContent={contents.original}
                  modifiedContent={contents.modified}
                  language={language}
                  filePath={file.path}
                  relativePath={file.path}
                  sideBySide={false}
                  onAddLineComment={handleAddLineComment}
                  addLineCommentLabel="Comment"
                  addLineCommentPlaceholder="Add a review comment"
                />
              </Suspense>
            )
          ) : null}
        </div>
      )}
    </div>
  )
}

function CommentCodeContext({
  comment,
  repoPath,
  prNumber,
  files,
  headSha,
  baseSha
}: {
  comment: PRComment
  repoPath: string | null
  prNumber: number
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
}): React.JSX.Element | null {
  const [contents, setContents] = useState<GitHubPRFileContents | null>(null)
  const [error, setError] = useState(false)
  const [contextBefore, setContextBefore] = useState(0)
  const [contextAfter, setContextAfter] = useState(0)
  const file = useMemo(
    () => files.find((candidate) => candidate.path === comment.path),
    [comment.path, files]
  )
  const line = comment.line
  const startLine = comment.startLine ?? line

  useEffect(() => {
    setContents(null)
    setError(false)
    if (!repoPath || !file || !headSha || !baseSha || !line || file.isBinary) {
      return
    }
    let cancelled = false
    loadPRFileContents({ repoPath, prNumber, file, headSha, baseSha })
      .then((result) => {
        if (!cancelled) {
          setContents(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [baseSha, file, headSha, line, prNumber, repoPath])

  useEffect(() => {
    setContextBefore(0)
    setContextAfter(0)
  }, [comment.id])

  if (!comment.path || !line || !file || file.isBinary || error) {
    return null
  }

  if (!contents) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Loading code context…
      </div>
    )
  }

  const source = contents.modified || contents.original
  const lines = source.split(/\r?\n/)
  const language = detectLanguage(comment.path)
  const commentFrom = Math.max(1, Math.min(startLine ?? line, line))
  const commentTo = Math.min(lines.length, Math.max(startLine ?? line, line))
  const from = Math.max(1, commentFrom - contextBefore)
  const to = Math.min(lines.length, commentTo + contextAfter)
  const selectedLines = lines.slice(from - 1, to)
  const candidateBlockRange = findNearestBraceBlock(lines, commentFrom)
  const candidateBlockLineCount = candidateBlockRange
    ? candidateBlockRange.endLine - candidateBlockRange.startLine + 1
    : 0
  const isWholeFileBlock =
    candidateBlockRange !== null &&
    candidateBlockRange.startLine <= 2 &&
    candidateBlockRange.endLine >= lines.length - 1
  const shouldUseBlockRange =
    candidateBlockRange !== null &&
    !isWholeFileBlock &&
    candidateBlockLineCount <= CODE_CONTEXT_MAX_BLOCK_LINES
  const blockRange = shouldUseBlockRange
    ? candidateBlockRange
    : {
        startLine: Math.max(1, commentFrom - CODE_CONTEXT_FALLBACK_LINES),
        endLine: Math.min(lines.length, commentTo + CODE_CONTEXT_FALLBACK_LINES)
      }
  const canExpandAbove = from > 1
  const canExpandBelow = to < lines.length
  const canExpandBlock = blockRange.startLine < from || blockRange.endLine > to
  const blockTooltip = shouldUseBlockRange
    ? 'Show surrounding code block'
    : 'Show nearby code context'

  if (selectedLines.length === 0) {
    return null
  }

  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border/50 bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono">{comment.path}</span>
          <span className="shrink-0 font-mono">
            L{from}
            {to !== from ? `-L${to}` : ''}
          </span>
          {(from !== commentFrom || to !== commentTo) && (
            <span className="shrink-0 font-mono text-muted-foreground/70">
              comment L{commentFrom}
              {commentTo !== commentFrom ? `-L${commentTo}` : ''}
            </span>
          )}
        </div>
        <ButtonGroup className="text-muted-foreground" aria-label="Code context controls">
          {(contextBefore > 0 || contextAfter > 0) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setContextBefore(0)
                    setContextAfter(0)
                  }}
                  aria-label="Reset code context"
                >
                  <UndoDot className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset code context</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandAbove}
                onClick={() =>
                  setContextBefore((current) =>
                    Math.min(current + CODE_CONTEXT_EXPAND_STEP, commentFrom - 1)
                  )
                }
                aria-label={`Show ${CODE_CONTEXT_EXPAND_STEP} more lines above`}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show more lines above</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandBelow}
                onClick={() =>
                  setContextAfter((current) =>
                    Math.min(current + CODE_CONTEXT_EXPAND_STEP, lines.length - commentTo)
                  )
                }
                aria-label={`Show ${CODE_CONTEXT_EXPAND_STEP} more lines below`}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show more lines below</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandBlock}
                onClick={() => {
                  setContextBefore((current) =>
                    Math.max(current, Math.max(0, commentFrom - blockRange.startLine))
                  )
                  setContextAfter((current) =>
                    Math.max(current, Math.max(0, blockRange.endLine - commentTo))
                  )
                }}
                aria-label={blockTooltip}
              >
                <Braces className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{blockTooltip}</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </div>
      <Suspense
        fallback={
          <pre className="overflow-x-auto py-1 text-[12px] leading-5">
            {selectedLines.map((codeLine, index) => {
              const lineNumber = from + index
              const isCommentedLine = lineNumber >= commentFrom && lineNumber <= commentTo
              return (
                <div
                  key={lineNumber}
                  className={cn('flex font-mono', isCommentedLine && 'bg-emerald-500/10')}
                >
                  <span className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground">
                    {lineNumber}
                  </span>
                  <code className="min-w-0 flex-1 px-3 text-foreground">{codeLine || ' '}</code>
                </div>
              )
            })}
          </pre>
        }
      >
        <MonacoCodeExcerpt
          lines={selectedLines}
          firstLineNumber={from}
          highlightedStartLine={commentFrom}
          highlightedEndLine={commentTo}
          language={language}
        />
      </Suspense>
    </div>
  )
}

function ConversationTab({
  item,
  repoPath,
  body,
  comments,
  files,
  headSha,
  baseSha,
  loading,
  checks,
  participants: detailsParticipants,
  onUse,
  onCommentAdded
}: {
  item: GitHubWorkItem
  repoPath: string | null
  body: string
  comments: PRComment[]
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  loading: boolean
  checks: GitHubWorkItemDetails['checks']
  participants: GitHubAssignableUser[]
  onUse: (item: GitHubWorkItem) => void
  onCommentAdded: (comment: PRComment) => void
}): React.JSX.Element {
  const authorLabel = item.author ?? 'unknown'
  const [replyingTo, setReplyingTo] = useState<number | null>(null)
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const repoAssignees = useRepoAssignees(repoPath)
  const commentCounts = useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const visibleComments = useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter),
    [commentFilter, comments]
  )
  const visibleCommentGroups = useMemo(() => groupPRComments(visibleComments), [visibleComments])
  const mentionOptions = useMemo(
    () =>
      buildMentionOptions({
        item,
        comments,
        participants: detailsParticipants,
        assignableUsers: repoAssignees.data
      }),
    [comments, detailsParticipants, item, repoAssignees.data]
  )

  useEffect(() => {
    if (replyingTo !== null && !visibleComments.some((comment) => comment.id === replyingTo)) {
      setReplyingTo(null)
    }
  }, [replyingTo, visibleComments])

  const handleReply = useCallback(
    async (comment: PRComment, replyBody: string): Promise<boolean> => {
      if (!repoPath) {
        toast.error('Unable to reply without a repository path.')
        return false
      }
      const result =
        comment.path && item.type === 'pr'
          ? await window.api.gh.addPRReviewCommentReply({
              repoPath,
              prNumber: item.number,
              commentId: comment.id,
              body: replyBody,
              threadId: comment.threadId,
              path: comment.path,
              line: comment.line
            })
          : await window.api.gh.addIssueComment({
              repoPath,
              number: item.number,
              body: `@${comment.author} ${replyBody}`,
              type: item.type
            })

      if (!result.ok) {
        toast.error(result.error || 'Failed to post reply.')
        return false
      }
      onCommentAdded(result.comment)
      setReplyingTo(null)
      toast.success('Reply posted.')
      return true
    },
    [item.number, item.type, onCommentAdded, repoPath]
  )

  const startWorkspaceButton = (
    <Button
      onClick={() => onUse(item)}
      className="w-full justify-center gap-2"
      aria-label={`Start workspace from ${item.type === 'pr' ? 'PR' : 'issue'}`}
    >
      {`Start workspace from ${item.type === 'pr' ? 'PR' : 'issue'}`}
      <ArrowRight className="size-4" />
    </Button>
  )

  const rightPanel =
    item.type === 'pr' ? (
      <div className="flex h-fit flex-col gap-3 xl:sticky xl:top-4">
        {startWorkspaceButton}
        <aside className="rounded-lg border border-border/50 bg-background/30">
          <div className="flex h-10 items-center gap-2 border-b border-border/50 px-3">
            <CircleDashed className="size-3.5 text-muted-foreground" />
            <span className="text-[13px] font-medium text-foreground">Checks</span>
            <span className="text-[12px] text-muted-foreground">{(checks ?? []).length}</span>
          </div>
          <ChecksTab checks={checks} loading={loading} />
        </aside>
      </div>
    ) : null

  const renderCommentCard = (comment: PRComment, isReply = false): React.JSX.Element => (
    <div
      key={comment.id}
      className={cn(
        'rounded-lg border border-border/40 bg-background/30',
        isReply && 'ml-6',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        {comment.authorAvatarUrl ? (
          <img
            src={comment.authorAvatarUrl}
            alt={comment.author}
            className="size-5 shrink-0 rounded-full"
          />
        ) : (
          <div className="size-5 shrink-0 rounded-full bg-muted" />
        )}
        <span
          className={cn(
            'text-[13px] font-semibold',
            comment.isResolved ? PR_COMMENT_RESOLVED_AUTHOR_CLASS : PR_COMMENT_OPEN_AUTHOR_CLASS
          )}
        >
          {comment.author}
        </span>
        <span className="text-[12px] text-muted-foreground">
          · {formatRelativeTime(comment.createdAt)}
        </span>
        {comment.path && (
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {comment.path.split('/').pop()}
            {comment.line ? `:L${comment.line}` : ''}
          </span>
        )}
        {comment.isResolved && (
          <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            resolved
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
                onClick={() =>
                  setReplyingTo((current) => (current === comment.id ? null : comment.id))
                }
                aria-label="Reply to comment"
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reply to comment</TooltipContent>
          </Tooltip>
          {comment.url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7"
                  onClick={() => window.api.shell.openUrl(comment.url)}
                  aria-label="Open comment on GitHub"
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open comment on GitHub</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        <CommentCodeContext
          comment={comment}
          repoPath={repoPath}
          prNumber={item.number}
          files={files}
          headSha={headSha}
          baseSha={baseSha}
        />
        <CommentMarkdown
          content={comment.body}
          variant="document"
          className="text-[13px] leading-relaxed"
        />
        <CommentReactions reactions={comment.reactions} />
        {replyingTo === comment.id && (
          <CommentReplyForm
            className="mt-3"
            placeholder={
              comment.path ? 'Reply in this review thread' : `Reply to @${comment.author}`
            }
            mentionOptions={mentionOptions}
            onCancel={() => setReplyingTo(null)}
            onSubmit={(replyBody) => handleReply(comment, replyBody)}
          />
        )}
      </div>
    </div>
  )

  const renderCommentGroup = (group: PRCommentGroup): React.JSX.Element => {
    const cards =
      group.kind === 'thread'
        ? [
            renderCommentCard(group.root),
            ...group.replies.map((reply) => renderCommentCard(reply, true))
          ]
        : [renderCommentCard(group.comment)]

    if (!isResolvedPRCommentGroup(group)) {
      return (
        <div key={getPRCommentGroupId(group)} className="flex flex-col gap-3">
          {cards}
        </div>
      )
    }

    const root = getPRCommentGroupRoot(group)
    const count = getPRCommentGroupCount(group)
    return (
      <Accordion key={getPRCommentGroupId(group)} type="single" collapsible>
        <AccordionItem
          value={getPRCommentGroupId(group)}
          className="rounded-lg border border-border/40 bg-background/20"
        >
          <AccordionTrigger className="px-3 py-2 text-[13px] text-muted-foreground hover:bg-accent/30">
            <span className="min-w-0 truncate">
              Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {root.author}
              {count > 1 ? ` (${count})` : ''}
            </span>
          </AccordionTrigger>
          <AccordionContent className="flex flex-col gap-3 px-3 pb-3 pt-0">
            {cards}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    )
  }

  return (
    <div
      className={cn(
        'grid gap-4 px-4 py-4',
        item.type === 'pr' && 'xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]'
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="rounded-lg border border-border/50 bg-background/40">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">{authorLabel}</span>
            <span>· {formatRelativeTime(item.updatedAt)}</span>
          </div>
          <div className="px-3 py-3 text-[14px] leading-relaxed text-foreground">
            {body.trim() ? (
              <CommentMarkdown
                content={body}
                variant="document"
                className="text-[14px] leading-relaxed"
              />
            ) : (
              <span className="italic text-muted-foreground">No description provided.</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <MessageSquare className="size-4 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">Comments</span>
          {comments.length > 0 && (
            <span className="text-[12px] text-muted-foreground">{comments.length}</span>
          )}
        </div>

        {item.type === 'pr' && comments.length > 0 && (
          <div className="grid grid-cols-3 rounded-lg border border-border/50 bg-background p-0.5">
            {PR_COMMENT_AUDIENCE_FILTERS.map((filter) => {
              const isActive = commentFilter === filter.value
              return (
                <button
                  key={filter.value}
                  type="button"
                  className={cn(
                    'flex h-8 items-center justify-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors',
                    isActive && 'bg-muted text-foreground'
                  )}
                  aria-pressed={isActive}
                  onClick={() => setCommentFilter(filter.value)}
                >
                  <span>{filter.label}</span>
                  <span className="tabular-nums">{commentCounts[filter.value]}</span>
                </button>
              )
            })}
          </div>
        )}

        {loading && comments.length === 0 ? (
          <div className="flex items-center justify-center py-6">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : comments.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No comments yet.</p>
        ) : visibleComments.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {getPRCommentAudienceEmptyLabel(commentFilter)}
          </p>
        ) : (
          <div className="flex flex-col gap-3">{visibleCommentGroups.map(renderCommentGroup)}</div>
        )}

        {repoPath && (
          <GHCommentComposer
            className="mt-1"
            repoPath={repoPath}
            issueNumber={item.number}
            itemType={item.type}
            mentionOptions={mentionOptions}
            onCommentAdded={onCommentAdded}
          />
        )}
      </div>

      {rightPanel}
    </div>
  )
}

function CommentReactions({
  reactions
}: {
  reactions?: GitHubReaction[]
}): React.JSX.Element | null {
  const visibleReactions = (reactions ?? []).filter((reaction) => reaction.count > 0)
  if (visibleReactions.length === 0) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visibleReactions.map((reaction) => (
        <span
          key={reaction.content}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-2 text-[12px] leading-none text-foreground"
          aria-label={`${reaction.count} ${reaction.content} reaction${reaction.count === 1 ? '' : 's'}`}
        >
          <span aria-hidden="true">{REACTION_EMOJI[reaction.content]}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </span>
      ))}
    </div>
  )
}

function CommentReplyForm({
  className,
  placeholder,
  mentionOptions,
  onCancel,
  onSubmit
}: {
  className?: string
  placeholder: string
  mentionOptions: MentionOption[]
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed || submitting) {
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmit(trimmed)
      if (ok) {
        setBody('')
      }
    } finally {
      setSubmitting(false)
    }
  }, [body, onSubmit, submitting])

  return (
    <div className={cn('rounded-md border border-border/50 bg-background/60 p-2', className)}>
      <MentionTextarea
        textareaRef={textareaRef}
        value={body}
        onValueChange={setBody}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
            return
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        rows={3}
        mentionOptions={mentionOptions}
        className="scrollbar-sleek min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim() || submitting} onClick={() => void submit()}>
          {submitting ? 'Posting…' : 'Reply'}
        </Button>
      </div>
    </div>
  )
}

function ChecksTab({
  checks,
  loading
}: {
  checks: GitHubWorkItemDetails['checks']
  loading: boolean
}): React.JSX.Element {
  const list = checks ?? []
  if (loading && list.length === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (list.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
        No checks configured.
      </div>
    )
  }
  return (
    <div className="px-2 py-2">
      {list.map((check) => {
        const conclusion = check.conclusion ?? 'pending'
        const Icon = CHECK_ICON[conclusion] ?? CircleDashed
        const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
        return (
          <button
            key={check.name}
            type="button"
            onClick={() => {
              if (check.url) {
                window.api.shell.openUrl(check.url)
              }
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition',
              check.url ? 'hover:bg-muted/40' : ''
            )}
          >
            <Icon
              className={cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin')}
            />
            <span className="flex-1 truncate text-[12px] text-foreground">{check.name}</span>
            {check.url && <ExternalLink className="size-3 shrink-0 text-muted-foreground/40" />}
          </button>
        )
      })}
    </div>
  )
}

function MentionTextarea({
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  rows,
  className,
  wrapperClassName,
  mentionOptions,
  textareaRef
}: {
  value: string
  onValueChange: (value: string) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  rows: number
  className?: string
  wrapperClassName?: string
  mentionOptions: MentionOption[]
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const suggestions = useMemo(
    () => (mentionQuery ? filterMentionOptions(mentionOptions, mentionQuery.query) : []),
    [mentionOptions, mentionQuery]
  )
  const showSuggestions = mentionQuery !== null && suggestions.length > 0

  const syncMentionQuery = useCallback((textarea: HTMLTextAreaElement): void => {
    const nextQuery = findMentionQuery(textarea.value, textarea.selectionStart)
    setMentionQuery(nextQuery)
    setActiveIndex(0)
  }, [])

  const insertMention = useCallback(
    (option: MentionOption): void => {
      const textarea = textareaRef.current
      const caret = textarea?.selectionStart ?? value.length
      const query = textarea ? findMentionQuery(value, caret) : mentionQuery
      if (!query) {
        return
      }
      const suffix = value[caret] && !/\s/.test(value[caret]) ? ' ' : ''
      const inserted = `@${option.login}${suffix}`
      const nextValue = `${value.slice(0, query.atIndex)}${inserted}${value.slice(caret)}`
      const nextCaret = query.atIndex + inserted.length
      onValueChange(nextValue)
      setMentionQuery(null)
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [mentionQuery, onValueChange, textareaRef, value]
  )

  return (
    <div className={cn('relative min-w-0 flex-1', wrapperClassName)}>
      {showSuggestions && (
        <div className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-50 max-h-64 overflow-y-auto rounded-md border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg">
          {suggestions.map((option, index) => (
            <button
              key={option.login}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                insertMention(option)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px]',
                index === activeIndex && 'bg-accent text-accent-foreground'
              )}
            >
              {option.avatarUrl ? (
                <img src={option.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
              ) : (
                <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                  {option.login.slice(0, 1).toUpperCase()}
                </div>
              )}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0 font-medium">@{option.login}</span>
                {option.name && (
                  <>
                    <span className="shrink-0 text-muted-foreground">|</span>
                    <span className="truncate text-muted-foreground">{option.name}</span>
                  </>
                )}
                <span className="shrink-0 text-muted-foreground">|</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{option.source}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
          syncMentionQuery(event.currentTarget)
        }}
        onClick={(event) => syncMentionQuery(event.currentTarget)}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            syncMentionQuery(event.currentTarget)
          }
        }}
        onBlur={() => setMentionQuery(null)}
        onKeyDown={(event) => {
          if (showSuggestions) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((current) => (current + 1) % suggestions.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              insertMention(suggestions[activeIndex] ?? suggestions[0])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMentionQuery(null)
              return
            }
          }
          onKeyDown?.(event)
        }}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
    </div>
  )
}

// Why: when the dialog opens for a Project row whose repo differs from the
// active workspace, mutations must target the row's actual repo via
// slug-addressed IPCs. Otherwise edits silently apply to the workspace's
// repo. The edit IPCs return a structured `{ ok, error }` shape; we adapt
// to a thrown rejection so the existing `useImmediateMutation` flow
// (which expects throws on failure) continues to work unchanged.
async function runIssueUpdate(args: {
  repoPath: string | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  number: number
  updates: Parameters<typeof window.api.gh.updateIssue>[0]['updates']
}): Promise<void> {
  if (args.projectOrigin) {
    const res = await window.api.gh.updateIssueBySlug({
      owner: args.projectOrigin.owner,
      repo: args.projectOrigin.repo,
      number: args.number,
      updates: args.updates
    })
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    return
  }
  if (!args.repoPath) {
    throw new Error('No repo context available for this edit.')
  }
  await window.api.gh.updateIssue({
    repoPath: args.repoPath,
    number: args.number,
    updates: args.updates
  })
}

function GHEditSection({
  item,
  repoPath,
  projectOrigin,
  localState,
  localLabels,
  onStateChange,
  onLabelsChange,
  onMutated,
  assignees,
  onUse
}: {
  item: GitHubWorkItem
  repoPath: string | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  localState: GitHubWorkItem['state']
  localLabels: string[]
  onStateChange: (state: GitHubWorkItem['state']) => void
  onLabelsChange: (labels: string[]) => void
  /** Why: called after a successful issue mutation so the parent dialog can
   *  invalidate its work-item-details cache entry. Without this, reopening the
   *  drawer in the FRESH_MS window would paint pre-mutation data. */
  onMutated: () => void
  assignees: string[]
  onUse: (item: GitHubWorkItem) => void
}): React.JSX.Element | null {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)
  const [localAssignees, setLocalAssignees] = useState<string[]>(assignees)
  const hasEditedAssigneesRef = useRef(false)
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)
  const { isPending, run } = useImmediateMutation()

  // Why: when the dialog opens from a Project view, mutations route through
  // *BySlug IPCs and we must keep `projectViewCache` in sync alongside
  // `workItemsCache` — `patchWorkItem` only walks the latter, so without this
  // helper the Project table would render stale data until manual refresh.
  // See docs/design/github-project-view-tasks.md §Dialog editing from Project rows.
  const patchProjectRowIfNeeded = useCallback(
    (patch: Parameters<typeof patchProjectRowContent>[2]) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, patch)
    },
    [projectOrigin, patchProjectRowContent]
  )

  // Why: when projectOrigin is set we MUST read labels/assignees from the
  // row's repo, not from the workspace path — otherwise the popovers list
  // values from a different repo than the writes target.
  const slugOwner = projectOrigin?.owner ?? null
  const slugRepo = projectOrigin?.repo ?? null
  const repoLabelsByPath = useRepoLabels(projectOrigin ? null : repoPath)
  const repoLabelsBySlug = useRepoLabelsBySlug(slugOwner, slugRepo)
  const repoLabels = projectOrigin ? repoLabelsBySlug : repoLabelsByPath
  const repoAssigneesByPath = useRepoAssignees(projectOrigin ? null : repoPath)
  const repoAssigneesBySlug = useRepoAssigneesBySlug(slugOwner, slugRepo, assignees)
  const repoAssignees = projectOrigin ? repoAssigneesBySlug : repoAssigneesByPath

  // Why: sync local assignees when item changes or when the detail fetch
  // resolves with real data — but skip if the user already made an
  // optimistic edit so we don't clobber in-flight changes.
  useEffect(() => {
    if (hasEditedAssigneesRef.current) {
      return
    }
    setLocalAssignees(assignees)
  }, [item.id, assignees])

  // Reset the dirty flag when we switch to a different item.
  useEffect(() => {
    hasEditedAssigneesRef.current = false
  }, [item.id])

  const handleStateChange = useCallback(
    (newState: 'open' | 'closed') => {
      if (newState === localState) {
        return
      }
      const prevState = localState
      run('state', {
        mutate: () =>
          runIssueUpdate({
            repoPath,
            projectOrigin,
            number: item.number,
            updates: { state: newState }
          }),
        onOptimistic: () => {
          onStateChange(newState)
          patchWorkItem(item.id, { state: newState })
          patchProjectRowIfNeeded({ state: newState })
        },
        onRevert: () => {
          onStateChange(prevState)
          patchWorkItem(item.id, { state: prevState })
          patchProjectRowIfNeeded({ state: prevState })
        },
        onSuccess: () => {
          patchWorkItem(item.id, { state: newState })
          patchProjectRowIfNeeded({ state: newState })
          onMutated()
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      item.id,
      item.number,
      localState,
      repoPath,
      projectOrigin,
      patchWorkItem,
      patchProjectRowIfNeeded,
      run,
      onStateChange,
      onMutated
    ]
  )

  const handleLabelToggle = useCallback(
    (label: string) => {
      const isAdding = !localLabels.includes(label)
      const prevLabels = localLabels
      const newLabels = isAdding ? [...prevLabels, label] : prevLabels.filter((l) => l !== label)

      if (isAdding) {
        run('labels', {
          mutate: () =>
            runIssueUpdate({
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { addLabels: [label] }
            }),
          onOptimistic: () => {
            onLabelsChange(newLabels)
            patchWorkItem(item.id, { labels: newLabels })
            patchProjectRowIfNeeded({ labels: newLabels })
          },
          onSuccess: () => {
            onMutated()
          },
          onRevert: () => {
            onLabelsChange(prevLabels)
            patchWorkItem(item.id, { labels: prevLabels })
            patchProjectRowIfNeeded({ labels: prevLabels })
          },
          onError: (err) => toast.error(err)
        })
      } else {
        run('labels', {
          mutate: () =>
            runIssueUpdate({
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { removeLabels: [label] }
            }),
          onOptimistic: () => {
            onLabelsChange(newLabels)
            patchWorkItem(item.id, { labels: newLabels })
            patchProjectRowIfNeeded({ labels: newLabels })
          },
          onRevert: () => {
            onLabelsChange(prevLabels)
            patchWorkItem(item.id, { labels: prevLabels })
            patchProjectRowIfNeeded({ labels: prevLabels })
          },
          onSuccess: () => {
            onMutated()
          },
          onError: (err) => toast.error(err)
        })
      }
    },
    [
      item.id,
      item.number,
      localLabels,
      repoPath,
      projectOrigin,
      patchWorkItem,
      patchProjectRowIfNeeded,
      run,
      onLabelsChange,
      onMutated
    ]
  )

  const handleAssigneeToggle = useCallback(
    (login: string) => {
      const isAssigned = localAssignees.includes(login)
      const prevAssignees = localAssignees
      const newAssignees = isAssigned
        ? prevAssignees.filter((l) => l !== login)
        : [...prevAssignees, login]

      hasEditedAssigneesRef.current = true
      if (isAssigned) {
        run('assignees', {
          mutate: () =>
            runIssueUpdate({
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { removeAssignees: [login] }
            }),
          onOptimistic: () => {
            setLocalAssignees(newAssignees)
            patchProjectRowIfNeeded({ assignees: newAssignees })
          },
          onRevert: () => {
            setLocalAssignees(prevAssignees)
            patchProjectRowIfNeeded({ assignees: prevAssignees })
          },
          onSuccess: () => {
            onMutated()
          },
          onError: (err) => toast.error(err)
        })
      } else {
        run('assignees', {
          mutate: () =>
            runIssueUpdate({
              repoPath,
              projectOrigin,
              number: item.number,
              updates: { addAssignees: [login] }
            }),
          onOptimistic: () => {
            setLocalAssignees(newAssignees)
            patchProjectRowIfNeeded({ assignees: newAssignees })
          },
          onSuccess: () => {
            onMutated()
          },
          onRevert: () => {
            setLocalAssignees(prevAssignees)
            patchProjectRowIfNeeded({ assignees: prevAssignees })
          },
          onError: (err) => toast.error(err)
        })
      }
    },
    [item.number, repoPath, projectOrigin, localAssignees, patchProjectRowIfNeeded, run, onMutated]
  )

  if (item.type === 'pr') {
    return null
  }

  const checkIcon = (
    <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      {/* State */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'group/status inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
              getStateTone({ ...item, state: localState })
            )}
          >
            {getStateLabel({ ...item, state: localState })}
            <ChevronDown className="size-2.5 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          <button
            type="button"
            onClick={() => handleStateChange('open')}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
              localState === 'open' && 'bg-accent/50'
            )}
          >
            <CircleDot className="size-3 text-emerald-500" />
            Open
          </button>
          <button
            type="button"
            onClick={() => handleStateChange('closed')}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
              localState === 'closed' && 'bg-accent/50'
            )}
          >
            <CircleDashed className="size-3 text-rose-500" />
            Closed
          </button>
        </PopoverContent>
      </Popover>

      {/* Labels */}
      <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('labels') || repoLabels.loading}
            className="group/labels inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
          >
            {localLabels.length === 0 ? (
              <span className="text-muted-foreground">+ Label</span>
            ) : (
              localLabels.map((name) => (
                <span key={name} className="text-[10px] text-muted-foreground">
                  {name}
                </span>
              ))
            )}
            {isPending('labels') ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-2.5 opacity-50" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {repoLabels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {repoLabels.error}
            </div>
          ) : (
            <div>
              {repoLabels.data.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => handleLabelToggle(label)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localLabels.includes(label)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localLabels.includes(label) && checkIcon}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Assignees */}
      <Popover open={assigneePopoverOpen} onOpenChange={setAssigneePopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('assignees') || repoAssignees.loading}
            className="group/assignees inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
          >
            {localAssignees.length === 0 ? (
              <span className="text-muted-foreground">+ Assignee</span>
            ) : (
              localAssignees.map((login) => (
                <span key={login} className="text-[10px] text-muted-foreground">
                  {login}
                </span>
              ))
            )}
            {isPending('assignees') ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-2.5 opacity-50" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {repoAssignees.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {repoAssignees.error}
            </div>
          ) : (
            <div>
              {repoAssignees.data.map((user) => (
                <button
                  key={user.login}
                  type="button"
                  onClick={() => handleAssigneeToggle(user.login)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localAssignees.includes(user.login)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localAssignees.includes(user.login) && checkIcon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{user.login}</span>
                    {user.name && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {user.name}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        onClick={() => onUse(item)}
        className="ml-auto gap-2"
        aria-label="Start workspace from issue"
      >
        Start workspace from issue
        <ArrowRight className="size-4" />
      </Button>
    </div>
  )
}

function GHCommentComposer({
  className,
  repoPath,
  issueNumber,
  itemType,
  mentionOptions,
  onCommentAdded
}: {
  className?: string
  repoPath: string
  issueNumber: number
  itemType: 'issue' | 'pr'
  mentionOptions: MentionOption[]
  onCommentAdded: (comment: PRComment) => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.max(80, Math.min(el.scrollHeight, 240))}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const result = await window.api.gh.addIssueComment({
        repoPath,
        number: issueNumber,
        body: trimmed,
        type: itemType
      })
      if (result.ok) {
        setBody('')
        requestAnimationFrame(autoGrow)
        // Why: use the comment returned by GitHub so the optimistic row shows
        // the real login/avatar immediately instead of waiting for a reopen.
        onCommentAdded(result.comment)
      } else {
        toast.error(result.error ?? 'Failed to add comment')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add comment')
    } finally {
      setSubmitting(false)
    }
  }, [autoGrow, body, repoPath, issueNumber, onCommentAdded])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      <MentionTextarea
        textareaRef={textareaRef}
        value={body}
        onValueChange={(nextValue) => {
          setBody(nextValue)
          requestAnimationFrame(autoGrow)
        }}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment…"
        rows={4}
        mentionOptions={mentionOptions}
        wrapperClassName="flex min-h-20 w-full items-stretch"
        className="scrollbar-sleek block h-20 max-h-[240px] min-h-20 w-full resize-none overflow-y-auto rounded-md border border-input bg-card px-3 py-2 text-[13px] leading-5 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button
        onClick={handleSubmit}
        disabled={!body.trim() || submitting}
        className="gap-2"
        aria-label="Send comment"
      >
        {submitting ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        Comment
      </Button>
    </div>
  )
}

// Why: the dialog doesn't carry the resolved PR-source slug the Tasks view's
// list cache carries, so we reach into workItemsCache to recover it. We scope
// the lookup to the dialog's own `repoPath` via the public
// `getWorkItemsAnySourcesForRepo` selector keyed by (repoPath, limit) —
// scanning the whole cache risks picking a sibling repo's PR-source when two
// selected repos share the same issue-source (e.g. two forks of the same
// upstream), producing an incorrect "Issues from" chip or incorrectly
// suppressing it. The selector keys primarily on the first-page entry
// (PER_REPO_FETCH_LIMIT, empty query) because sources are repo-level and
// don't vary by search query. If that slot is empty — e.g. the Tasks view is
// filtering by a typed query and only populated the query-keyed entry — the
// selector falls back to scanning cache entries prefixed by this same
// `repoPath::` and reuses sources from the first match. Falling back to hiding
// the indicator when we still can't find a match matches the parent design
// doc §1 rule: hide when either side is unknown rather than guessing.
function WorkItemIssueSourceIndicator({
  url,
  repoPath
}: {
  url: string
  repoPath: string | null
}): React.JSX.Element | null {
  // Why: subscribe to a single store-side selector that returns the resolved
  // sources for this repo — either the primary `(repoPath, PER_REPO_FETCH_LIMIT, '')`
  // entry or the first sibling cache entry that has sources (the Tasks view may
  // write cache entries keyed by a user-typed search query, so the primary slot
  // can be empty even when sources are known). Sources are repo-level
  // (query-independent), so any sibling entry is safe. When the primary slot
  // is populated its reference is stable across unrelated cache writes; when
  // the fallback path is used a sibling cache rewrite may produce a new
  // `sources` object and trigger a harmless extra render. That's cheap — the
  // indicator is small and the cache rewrite rate is bounded by user-initiated
  // refresh/search actions.
  const sources = useAppStore((s) =>
    s.getWorkItemsAnySourcesForRepo(repoPath ?? '', PER_REPO_FETCH_LIMIT)
  )
  const issues = useMemo<GitHubOwnerRepo | null>(() => {
    const fromUrl = parseOwnerRepoFromItemUrl(url)
    if (!fromUrl) {
      return null
    }
    // Prefer the cache's resolved issue-source when it matches the URL-derived
    // slug — the cache entry is authoritative (canonicalized by the main
    // process) while the URL parse is a best-effort fallback.
    const cachedIssues = sources?.issues
    if (cachedIssues && sameGitHubOwnerRepo(cachedIssues, fromUrl)) {
      return cachedIssues
    }
    return fromUrl
  }, [url, sources])
  const prs = sources?.prs ?? null

  if (!issues || !prs || sameGitHubOwnerRepo(issues, prs)) {
    return null
  }
  return (
    <div className="mt-1">
      <IssueSourceIndicator issues={issues} prs={prs} variant="item" />
    </div>
  )
}

export default function GitHubItemDialog({
  workItem,
  repoPath,
  projectOrigin,
  onUse,
  onClose
}: GitHubItemDialogProps): React.JSX.Element {
  const [tab, setTab] = useState<ItemDialogTab>('conversation')
  const [details, setDetails] = useState<GitHubWorkItemDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localState, setLocalState] = useState<GitHubWorkItem['state']>(workItem?.state ?? 'open')
  const [localLabels, setLocalLabels] = useState<string[]>(workItem?.labels ?? [])
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>('flat')
  const workItemId = workItem?.id
  const workItemState = workItem?.state
  const workItemLabels = workItem?.labels

  // Why: the cache key has to include the issue source preference so a user
  // toggling between origin/upstream for the same issue number doesn't read
  // back the wrong repo's details. We pull it from the repos slice rather
  // than threading it as a prop because every existing call site already has
  // the repo registered in the store.
  const issueSourcePreference = useAppStore((s) => {
    if (!repoPath) {
      return undefined
    }
    return s.repos.find((r) => r.path === repoPath)?.issueSourcePreference
  })
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !repoPath) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath,
      issueSourcePreference,
      type: workItem.type,
      number: workItem.number
    })
  }, [repoPath, workItem, issueSourcePreference])

  // Why: reset lifted edit state when the dialog switches items or when the
  // same item receives an optimistic cache patch from the surrounding table.
  useEffect(() => {
    if (workItemState && workItemLabels) {
      setLocalState(workItemState)
      setLocalLabels(workItemLabels)
    }
  }, [workItemId, workItemState, workItemLabels])

  const requestIdRef = useRef(0)
  // Why: track comments added optimistically before the detail fetch resolves
  // so they can be merged into the fetch result instead of being overwritten.
  const optimisticCommentsRef = useRef<PRComment[]>([])
  // Why: track the last item we fetched so we can distinguish "reopen same
  // item" from "switch to a different item". Reopening the same item must
  // preserve optimistic comments because gh's 60s response cache will return
  // stale data that doesn't include the just-posted comment.
  const prevItemIdRef = useRef<string | null>(null)

  // Why: when this dialog opens immediately after another Radix overlay
  // (e.g. the New Issue dialog) closed, Radix may leave `pointer-events: none`
  // on <body>. That silently kills clicks on the header's Close/open-in-GitHub
  // buttons. Poll a few frames to clear it whenever Radix re-applies it during
  // its own mount sequence.
  useEffect(() => {
    if (!workItem) {
      return
    }
    let cancelled = false
    let count = 0
    const tick = (): void => {
      if (cancelled) {
        return
      }
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = ''
      }
      if (count++ < 5) {
        requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [workItem])

  useEffect(() => {
    if (!workItem || !repoPath || !detailsCacheKey) {
      setDetails(null)
      setError(null)
      return
    }
    // Why: if the user clicks through several rows quickly, discard stale
    // responses by tagging each request with a monotonic id and only applying
    // results whose id matches the latest one.
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    // Why: only clear optimistic comments when switching to a genuinely
    // different item. When reopening the same item (close → reopen), the
    // gh API's 60s response cache will return stale data that omits the
    // just-posted comment — preserving the optimistic ref lets the merge
    // logic below re-attach it to the stale response.
    if (workItem.id !== prevItemIdRef.current) {
      optimisticCommentsRef.current = []
    }
    prevItemIdRef.current = workItem.id
    setTab('conversation')

    const cached = workItemDetailsCache.get(detailsCacheKey)
    const now = Date.now()
    const hasFreshData = cached?.details && now - cached.fetchedAt <= WORK_ITEM_DETAILS_FRESH_MS

    // Why: paint cached data immediately when we have it so reopen feels
    // instant. Only fall back to a blocking spinner when there's nothing to
    // show. Optimistic comments still merge below for both paths.
    if (cached?.details) {
      const opt = optimisticCommentsRef.current
      let painted = cached.details
      if (opt.length > 0) {
        const ids = new Set(painted.comments.map((c) => c.id))
        const missing = opt.filter((c) => !ids.has(c.id))
        if (missing.length > 0) {
          painted = { ...painted, comments: [...painted.comments, ...missing] }
        }
      }
      setDetails(painted)
      setError(null)
      setLoading(false)
    } else {
      setDetails(null)
      setError(null)
      setLoading(true)
    }

    if (hasFreshData) {
      return
    }

    // Why: dedupe concurrent opens for the same key — concurrent dialogs or
    // a rapid close→reopen must share one in-flight promise instead of
    // racing two `gh` subprocesses against each other.
    const inflight: Promise<GitHubWorkItemDetails | null> =
      cached?.pending ??
      window.api.gh.workItemDetails({
        repoPath,
        number: workItem.number,
        type: workItem.type
      })

    // Why: snapshot the invalidation generation at fetch start; if the
    // generation advances before we resolve, a mutation invalidated the
    // entry mid-flight and we must not write a stale result back.
    const launchedAtGeneration = workItemDetailsCacheGeneration

    if (!cached?.pending) {
      touchWorkItemDetailsCache(detailsCacheKey, {
        details: cached?.details ?? null,
        fetchedAt: cached?.fetchedAt ?? 0,
        pending: inflight,
        error: cached?.error
      })
    }

    inflight
      .then((result) => {
        const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
        // Why: 404/unauthorized must not overwrite valid cached data. When the
        // IPC resolves to null and we already have cached details, keep the
        // stale data — only blank entries get the null payload.
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (invalidatedMidFlight) {
          // Skip cache write entirely — the entry was deliberately dropped.
        } else if (result === null && prev?.details) {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: prev.details,
            fetchedAt: prev.fetchedAt,
            error: undefined
          })
        } else {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: result,
            fetchedAt: Date.now(),
            error: undefined
          })
        }
        if (requestId !== requestIdRef.current) {
          return
        }
        // Why: merge any comments the user posted optimistically while the
        // detail fetch was in-flight, using id to avoid duplicates.
        const opt = optimisticCommentsRef.current
        let merged = result
        if (opt.length > 0 && merged) {
          const fetchedIds = new Set(merged.comments.map((c: PRComment) => c.id))
          const missing = opt.filter((c) => !fetchedIds.has(c.id))
          if (missing.length > 0) {
            merged = { ...merged, comments: [...merged.comments, ...missing] }
          }
        }
        if (merged !== null || !cached?.details) {
          setDetails(merged)
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load details'
        const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
        const prev = workItemDetailsCache.get(detailsCacheKey)
        // Why: stale-on-error — keep cached data if we have it, drop the
        // pending promise so the next open can retry. Only surface the
        // blocking error when nothing is cached. If invalidated mid-flight,
        // don't restore stale data into the now-empty entry.
        if (!invalidatedMidFlight) {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: prev?.details ?? null,
            fetchedAt: prev?.fetchedAt ?? 0,
            error: message
          })
        }
        if (requestId !== requestIdRef.current) {
          return
        }
        if (!prev?.details) {
          setError(message)
        }
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setLoading(false)
      })
  }, [repoPath, workItem, detailsCacheKey])

  const Icon = workItem?.type === 'pr' ? GitPullRequest : CircleDot
  const body = details?.body ?? ''
  const comments = details?.comments ?? []
  const files = details?.files ?? []
  const checks = details?.checks ?? []

  const appendOptimisticComment = useCallback(
    (comment: PRComment) => {
      // Why: skip refreshDetails() — gh api --cache 60s returns stale data
      // that overwrites the optimistic comment. The next dialog open (after
      // cache expiry) will pick up the server-confirmed version.
      optimisticCommentsRef.current.push(comment)
      setDetails((prev) => {
        if (prev) {
          return { ...prev, comments: [...prev.comments, comment] }
        }
        if (!workItem) {
          return prev
        }
        // Why: details may still be loading — create a minimal shell
        // so the optimistic comment isn't silently dropped.
        return {
          item: workItem,
          body: '',
          comments: [comment]
        }
      })
      // Why: keep the module-level cache in sync so a reopen paints the new
      // comment without waiting on a refetch. Mark fetchedAt as stale (0) so
      // the next open still triggers a background refresh to pick up
      // server-side fields like reaction groups or thread bindings.
      if (detailsCacheKey) {
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (prev?.details) {
          const ids = new Set(prev.details.comments.map((c) => c.id))
          if (!ids.has(comment.id)) {
            touchWorkItemDetailsCache(detailsCacheKey, {
              details: { ...prev.details, comments: [...prev.details.comments, comment] },
              fetchedAt: 0,
              error: undefined
            })
          }
        }
      }
    },
    [workItem, detailsCacheKey]
  )

  return (
    <Sheet open={workItem !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px] lg:max-w-[760px] xl:max-w-[900px]"
        onOpenAutoFocus={(event) => {
          // Why: focusing the first actionable element inside the drawer
          // causes the "Start workspace" action to receive focus and
          // get visually highlighted on open. Preventing auto-focus keeps the
          // drawer feeling like a passive preview until the user acts.
          event.preventDefault()
        }}
      >
        {/* Why: SheetTitle/Description are required by Radix Dialog for a11y,
            but the visible header carries the same info. Wrap each with
            `asChild` so the VisuallyHidden span wraps the element cleanly. */}
        <VisuallyHidden.Root asChild>
          <SheetTitle>{workItem?.title ?? 'GitHub item'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            Read-only preview of the selected GitHub issue or pull request.
          </SheetDescription>
        </VisuallyHidden.Root>

        {workItem && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex-none border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[12px] text-muted-foreground">
                    #{workItem.number}
                  </span>
                  <h2 className="mt-1 flex items-start gap-2 text-[15px] font-semibold leading-tight text-foreground">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">{workItem.title}</span>
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
                    <span>{workItem.author ?? 'unknown'}</span>
                    <span>· {formatRelativeTime(workItem.updatedAt)}</span>
                    {workItem.branchName && (
                      <span className="font-mono text-[10px] text-muted-foreground/80">
                        · {workItem.branchName}
                      </span>
                    )}
                  </div>
                  {workItem.type === 'issue' && (
                    <WorkItemIssueSourceIndicator url={workItem.url} repoPath={repoPath} />
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => window.api.shell.openUrl(workItem.url)}
                        aria-label="Open on GitHub"
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Open on GitHub
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={onClose}
                        aria-label="Close preview"
                      >
                        <X className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Close · Esc
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {(repoPath || projectOrigin) && (
              <GHEditSection
                item={workItem}
                repoPath={repoPath}
                projectOrigin={projectOrigin}
                localState={localState}
                localLabels={localLabels}
                onStateChange={setLocalState}
                onLabelsChange={setLocalLabels}
                onMutated={() => {
                  // Why: drop the cached details for this item so the next
                  // open issues a fresh fetch instead of painting pre-edit
                  // state. We invalidate by (repoPath, type, number) match
                  // because a single mutation can affect entries across all
                  // issueSourcePreference values for the same number.
                  if (repoPath) {
                    invalidateWorkItemDetailsCacheByMatch({
                      repoPath,
                      type: workItem.type,
                      number: workItem.number
                    })
                  }
                }}
                assignees={details?.assignees ?? []}
                onUse={onUse}
              />
            )}

            <div className="min-h-0 flex-1">
              {error ? (
                <div className="px-4 py-6 text-[12px] text-destructive">{error}</div>
              ) : (
                <Tabs
                  value={tab}
                  onValueChange={(value) => setTab(value as ItemDialogTab)}
                  className="flex h-full min-h-0 flex-col gap-0"
                >
                  <TabsList
                    variant="line"
                    className="mx-4 mt-2 justify-start gap-3 border-b border-border/60"
                  >
                    <TabsTrigger value="conversation" className="px-2">
                      <MessageSquare className="size-3.5" />
                      Conversation
                    </TabsTrigger>
                    {workItem.type === 'pr' && (
                      <TabsTrigger value="files" className="px-2">
                        <FileText className="size-3.5" />
                        Files
                        {files.length > 0 && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            {files.length}
                          </span>
                        )}
                      </TabsTrigger>
                    )}
                  </TabsList>

                  <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
                    <TabsContent value="conversation" className="mt-0">
                      <ConversationTab
                        item={workItem}
                        repoPath={repoPath}
                        body={body}
                        comments={comments}
                        files={files}
                        headSha={details?.headSha}
                        baseSha={details?.baseSha}
                        loading={loading}
                        checks={checks}
                        participants={details?.participants ?? []}
                        onUse={onUse}
                        onCommentAdded={appendOptimisticComment}
                      />
                    </TabsContent>

                    {workItem.type === 'pr' && (
                      <TabsContent value="files" className="mt-0">
                        {loading && files.length === 0 ? (
                          <div className="flex items-center justify-center py-10">
                            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : files.length === 0 ? (
                          <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                            No files changed.
                          </div>
                        ) : (
                          <div>
                            {/* Files-tab toolbar: view-mode toggle */}
                            <div className="flex items-center justify-end gap-1 border-b border-border/40 px-3 py-1.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    id="pr-files-flat-view"
                                    type="button"
                                    onClick={() => setDiffViewMode('flat')}
                                    aria-label="Flat view"
                                    aria-pressed={diffViewMode === 'flat'}
                                    className={cn(
                                      'flex size-6 items-center justify-center rounded transition hover:bg-muted',
                                      diffViewMode === 'flat'
                                        ? 'bg-muted text-foreground'
                                        : 'text-muted-foreground'
                                    )}
                                  >
                                    <AlignJustify className="size-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" sideOffset={4}>
                                  Flat view
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    id="pr-files-tree-view"
                                    type="button"
                                    onClick={() => setDiffViewMode('tree')}
                                    aria-label="Tree view"
                                    aria-pressed={diffViewMode === 'tree'}
                                    className={cn(
                                      'flex size-6 items-center justify-center rounded transition hover:bg-muted',
                                      diffViewMode === 'tree'
                                        ? 'bg-muted text-foreground'
                                        : 'text-muted-foreground'
                                    )}
                                  >
                                    <LayoutList className="size-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" sideOffset={4}>
                                  Tree view
                                </TooltipContent>
                              </Tooltip>
                            </div>
                            {diffViewMode === 'flat' ? (
                              files.map((file) => (
                                <PRFileRow
                                  key={file.path}
                                  file={file}
                                  repoPath={repoPath ?? ''}
                                  prNumber={workItem.number}
                                  headSha={details?.headSha}
                                  baseSha={details?.baseSha}
                                  onCommentAdded={appendOptimisticComment}
                                />
                              ))
                            ) : (
                              <PRDiffTreeView
                                files={files}
                                repoPath={repoPath ?? ''}
                                prNumber={workItem.number}
                                headSha={details?.headSha}
                                baseSha={details?.baseSha}
                                onCommentAdded={appendOptimisticComment}
                              />
                            )}
                          </div>
                        )}
                      </TabsContent>
                    )}
                  </div>
                </Tabs>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
