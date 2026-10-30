import type { GitHubPRFile } from '../../../src/shared/github/pull-request-types'
import type { PRComment } from '../../../src/shared/github/comment-types'
import type { SourceControlViewMode } from '../../../src/shared/ui-chrome-types'
import {
  isPRFileChangedSinceViewed,
  isPRFileViewed
} from '../../../src/shared/github/pull-request-file-state'
import { getPRCommentInlineAnchor } from '../../../src/shared/github/pr-comment-inline-anchor'
import { getPRCommentGroupRoot, groupPRComments } from '../../../src/shared/pr-comment-groups'
import {
  buildSourceControlTree,
  compactSourceControlTree,
  type SourceControlTreeNode
} from '../../../src/shared/source-control-tree'
import { compareFileNames } from '../../../src/shared/file-name-sort'
import { isTestCodePath } from '../../../src/shared/test-code-path'

export type MobilePrFileFilter = 'unviewed' | 'commented' | 'tests'

export const MOBILE_PR_FILE_FILTERS: readonly MobilePrFileFilter[] = [
  'unviewed',
  'commented',
  'tests'
]

export type MobilePrFileRow =
  | {
      kind: 'directory'
      key: string
      name: string
      depth: number
      fileCount: number
      viewedCount: number
      threadCount: number
      collapsed: boolean
    }
  | {
      kind: 'file'
      key: string
      file: GitHubPRFile
      name: string
      /** Parent folder, shown under the name in the flat list. */
      directory: string
      depth: number
      viewed: boolean
      changedSinceViewed: boolean
      threadCount: number
    }

type PrFileTreeNode = SourceControlTreeNode<GitHubPRFile, 'pr'>

// Below this a tree only adds nesting.
const TREE_MIN_FILES = 5

export function resolveMobilePrFilesViewMode(
  chosen: SourceControlViewMode | null,
  fileCount: number
): SourceControlViewMode {
  return chosen ?? (fileCount < TREE_MIN_FILES ? 'list' : 'tree')
}

/** Thread count per path, from comments that still sit on a line of the current diff. */
export function countMobilePrFileThreads(comments: readonly PRComment[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const group of groupPRComments(comments)) {
    const anchor = getPRCommentInlineAnchor(getPRCommentGroupRoot(group))
    if (anchor) {
      counts.set(anchor.path, (counts.get(anchor.path) ?? 0) + 1)
    }
  }
  return counts
}

function matchesFilter(
  file: GitHubPRFile,
  filter: MobilePrFileFilter,
  threadCounts: ReadonlyMap<string, number>
): boolean {
  switch (filter) {
    case 'unviewed':
      return !isPRFileViewed(file)
    case 'commented':
      return (threadCounts.get(file.path) ?? 0) > 0
    case 'tests':
      return isTestCodePath(file.path)
  }
}

export function countMobilePrFileFilterMatches(
  files: readonly GitHubPRFile[],
  threadCounts: ReadonlyMap<string, number>
): Record<MobilePrFileFilter, number> {
  const counts: Record<MobilePrFileFilter, number> = { unviewed: 0, commented: 0, tests: 0 }
  for (const file of files) {
    for (const filter of MOBILE_PR_FILE_FILTERS) {
      if (matchesFilter(file, filter, threadCounts)) {
        counts[filter] += 1
      }
    }
  }
  return counts
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function fileRow(
  file: GitHubPRFile,
  name: string,
  depth: number,
  threadCounts: ReadonlyMap<string, number>
): Extract<MobilePrFileRow, { kind: 'file' }> {
  return {
    kind: 'file',
    key: `file:${file.path}`,
    file,
    name,
    directory: directoryOf(file.path),
    depth,
    viewed: isPRFileViewed(file),
    changedSinceViewed: isPRFileChangedSinceViewed(file),
    threadCount: threadCounts.get(file.path) ?? 0
  }
}

export function buildMobilePrFileRows({
  files,
  threadCounts,
  filters,
  viewMode,
  directoryExpansion
}: {
  files: readonly GitHubPRFile[]
  threadCounts: ReadonlyMap<string, number>
  filters: ReadonlySet<MobilePrFileFilter>
  viewMode: SourceControlViewMode
  /** The user's explicit open/closed choice per folder key; unset folders fold once fully viewed. */
  directoryExpansion: ReadonlyMap<string, boolean>
}): MobilePrFileRow[] {
  const active = [...filters]
  const visible = files.filter((file) =>
    active.every((filter) => matchesFilter(file, filter, threadCounts))
  )
  if (viewMode === 'list') {
    return visible
      .sort((a, b) => compareFileNames(a.path, b.path))
      .map((file) =>
        fileRow(file, file.path.slice(file.path.lastIndexOf('/') + 1), 0, threadCounts)
      )
  }

  const rows: MobilePrFileRow[] = []
  // Returns [fileCount, viewedCount, threadCount] so each folder row can summarise its subtree.
  const visit = (node: PrFileTreeNode, out: MobilePrFileRow[]): [number, number, number] => {
    if (node.type === 'file') {
      const row = fileRow(node.entry, node.name, node.depth, threadCounts)
      out.push(row)
      return [1, row.viewed ? 1 : 0, row.threadCount]
    }
    const children: MobilePrFileRow[] = []
    let totals: [number, number, number] = [0, 0, 0]
    for (const child of node.children) {
      const [files, viewed, threads] = visit(child, children)
      totals = [totals[0] + files, totals[1] + viewed, totals[2] + threads]
    }
    const [fileCount, viewedCount, threadCount] = totals
    // Fold fully viewed folders only in the unfiltered tree; a filter's counts cover just its matches.
    const autoOpen = filters.size > 0 || viewedCount < fileCount
    const collapsed = !(directoryExpansion.get(node.key) ?? autoOpen)
    out.push({
      kind: 'directory',
      key: node.key,
      name: node.name,
      depth: node.depth,
      fileCount,
      viewedCount,
      threadCount,
      collapsed
    })
    if (!collapsed) {
      out.push(...children)
    }
    return totals
  }
  for (const root of compactSourceControlTree(buildSourceControlTree('pr', visible))) {
    visit(root, rows)
  }
  return rows
}
