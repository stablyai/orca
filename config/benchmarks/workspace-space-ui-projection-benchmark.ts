import { performance } from 'node:perf_hooks'
import type { WorkspaceSpaceWorktree } from '../../src/shared/workspace-space-types'
import {
  filterWorkspaceSpaceRows,
  getWorkspaceSpaceGitStatusRefreshCandidates,
  sortWorkspaceSpaceRows
} from '../../src/renderer/src/components/status-bar/workspace-space-presentation'
import { buildTreemapLayout } from '../../src/renderer/src/components/status-bar/workspace-space-layout'
import { stats, type TimingStats } from './non-terminal-benchmark-stats'
import { buildWorkspaceSpaceEditorActivityByWorktree } from '../../src/renderer/src/components/status-bar/workspace-space-editor-activity'

const UI_ITERATIONS = 100

export type WorkspaceSpaceProjectionResult = {
  scenario: string
  rows: number
  outputRows: number
  candidates: number
  stats: TimingStats
}

export type WorkspaceSpaceDecisionShapeResult = {
  scenario: string
  rows: number
  openFiles: number
  legacyUnindexedStats: TimingStats
  productionIndexedStats: TimingStats
}

type ProjectionScenario = {
  scenario: string
  run: () => { outputRows: number; candidates: number }
}

type OpenFileShape = {
  id: string
  worktreeId: string
  isDirty: boolean
}

function makeWorkspaceSpaceRows(rowCount: number): WorkspaceSpaceWorktree[] {
  return Array.from({ length: rowCount }, (_, index) => ({
    worktreeId: `worktree-${index}`,
    repoId: `repo-${index % 50}`,
    repoDisplayName: `Repo ${index % 50}`,
    repoPath: `/tmp/repo-${index % 50}`,
    displayName: `Workspace ${index}`,
    path: `/tmp/repo-${index % 50}/workspace-${index}`,
    branch: index % 5 === 0 ? 'main' : `feature/${index}`,
    isMainWorktree: index % 25 === 0,
    isRemote: false,
    isSparse: false,
    canDelete: index % 25 !== 0,
    lastActivityAt: 1_700_000_000_000 - index * 1000,
    scannedAt: 1_700_000_000_000,
    status: 'ok',
    error: null,
    sizeBytes: (rowCount - index) * 1024 * 64,
    reclaimableBytes: index % 25 === 0 ? 0 : (rowCount - index) * 1024 * 64,
    skippedEntryCount: 0,
    topLevelItems: makeTopLevelItems(index),
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  })) as WorkspaceSpaceWorktree[]
}

function makeTopLevelItems(index: number): WorkspaceSpaceWorktree['topLevelItems'] {
  return Array.from({ length: 12 }, (_, itemIndex) => ({
    name: `item-${itemIndex}`,
    path: `/tmp/repo-${index % 50}/workspace-${index}/item-${itemIndex}`,
    kind: itemIndex % 4 === 0 ? 'file' : 'directory',
    sizeBytes: (12 - itemIndex) * 1024 * 8
  }))
}

function projectionScenarios(rows: WorkspaceSpaceWorktree[]): ProjectionScenario[] {
  return [
    {
      scenario: 'filter query + sort by size',
      run: () => ({
        outputRows: sortWorkspaceSpaceRows(
          filterWorkspaceSpaceRows(rows, 'workspace 9', false),
          'size',
          'desc'
        ).length,
        candidates: 0
      })
    },
    {
      scenario: 'only deletable + sort by repo',
      run: () => ({
        outputRows: sortWorkspaceSpaceRows(filterWorkspaceSpaceRows(rows, '', true), 'repo', 'asc')
          .length,
        candidates: 0
      })
    },
    {
      scenario: 'git-status candidate selection',
      run: () => {
        const candidates = getWorkspaceSpaceGitStatusRefreshCandidates(rows).length
        return { outputRows: candidates, candidates }
      }
    },
    {
      scenario: 'treemap layout for all visible rows',
      run: () => ({
        outputRows: buildTreemapLayout(
          rows.map((row) => ({
            id: row.worktreeId,
            label: row.displayName,
            sizeBytes: row.sizeBytes
          }))
        ).length,
        candidates: 0
      })
    }
  ]
}

export function measureWorkspaceSpaceProjection(
  rowCount: number
): WorkspaceSpaceProjectionResult[] {
  const rows = makeWorkspaceSpaceRows(rowCount)
  return projectionScenarios(rows).map((scenario) => {
    let latest = { outputRows: 0, candidates: 0 }
    const timing = stats(
      Array.from({ length: UI_ITERATIONS }, () => {
        const startedAt = performance.now()
        latest = scenario.run()
        return performance.now() - startedAt
      })
    )
    return {
      scenario: scenario.scenario,
      rows: rowCount,
      outputRows: latest.outputRows,
      candidates: latest.candidates,
      stats: timing
    }
  })
}

function makeOpenFilesForRows(
  rows: WorkspaceSpaceWorktree[],
  filesPerRow: number
): OpenFileShape[] {
  return rows.flatMap((row) =>
    Array.from({ length: filesPerRow }, (_, index) => ({
      id: `${row.worktreeId}/file-${index}`,
      worktreeId: row.worktreeId,
      isDirty: index % 7 === 0
    }))
  )
}

function countEditorFilesCurrentShape(
  rows: WorkspaceSpaceWorktree[],
  openFiles: OpenFileShape[]
): number {
  let dirtyCount = 0
  for (const row of rows) {
    const rowFiles = openFiles.filter((file) => file.worktreeId === row.worktreeId)
    dirtyCount += rowFiles.filter((file) => file.isDirty).length
  }
  return dirtyCount
}

function countEditorFilesProductionIndexed(
  rows: WorkspaceSpaceWorktree[],
  openFiles: OpenFileShape[]
): number {
  const activityByWorktree = buildWorkspaceSpaceEditorActivityByWorktree(openFiles, {})
  return rows.reduce(
    (total, row) => total + (activityByWorktree.get(row.worktreeId)?.dirtyBufferCount ?? 0),
    0
  )
}

export function measureWorkspaceSpaceDecisionShape(
  rowCount: number
): WorkspaceSpaceDecisionShapeResult {
  const rows = makeWorkspaceSpaceRows(rowCount)
  const openFiles = makeOpenFilesForRows(rows, 5)
  let sink = 0
  const legacyUnindexedStats = stats(
    Array.from({ length: UI_ITERATIONS }, () => {
      const startedAt = performance.now()
      sink += countEditorFilesCurrentShape(rows, openFiles)
      return performance.now() - startedAt
    })
  )
  const productionIndexedStats = stats(
    Array.from({ length: UI_ITERATIONS }, () => {
      const startedAt = performance.now()
      sink += countEditorFilesProductionIndexed(rows, openFiles)
      return performance.now() - startedAt
    })
  )
  if (sink === Number.MIN_SAFE_INTEGER) {
    throw new Error('unreachable')
  }
  return {
    scenario: 'Resource Manager delete-readiness editor-file counting shape',
    rows: rowCount,
    openFiles: openFiles.length,
    legacyUnindexedStats,
    productionIndexedStats
  }
}
