// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileSourceControlFileList, type FileListState } from './MobileSourceControlFileList'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))
vi.mock('lucide-react-native', () => ({
  ArrowDown: () => null,
  ArrowDownUp: () => null,
  ArrowUp: () => null,
  Check: () => null,
  ChevronRight: () => null,
  CloudUpload: () => null,
  FileText: () => null,
  GitBranch: () => null,
  GitPullRequestArrow: () => null,
  History: () => null,
  Minus: () => null,
  Plus: () => null,
  RefreshCw: () => null,
  Trash2: () => null
}))

function fileListState(count: number, dirty: boolean): FileListState {
  const branchEntries = Array.from({ length: count }, (_, index) => ({
    path: `src/committed-${index}.ts`,
    status: 'modified' as const,
    added: 1,
    removed: 0,
    canOpen: true
  }))
  const branchCompareResult = {
    summary: {
      status: 'ready' as const,
      baseRef: 'main',
      changedFiles: count,
      commitsAhead: 1,
      errorMessage: undefined
    },
    entries: branchEntries
  }
  return {
    sections: dirty
      ? [
          {
            id: 'unstaged',
            area: 'unstaged',
            title: 'Changes',
            data: [
              {
                area: 'unstaged',
                path: 'src/uncommitted.ts',
                status: 'modified',
                canOpen: true,
                canStage: true,
                canUnstage: false,
                canDiscard: true,
                stageActionId: 'stage:src/uncommitted.ts',
                unstageActionId: 'unstage:src/uncommitted.ts',
                discardActionId: 'discard:src/uncommitted.ts',
                conflictResolutions: [],
                resolveActionId: 'resolve:src/uncommitted.ts'
              }
            ]
          }
        ]
      : [],
    shouldShowBranchCompareSection: true,
    branchCompareSummaryText: `${count} files vs main`,
    branchEntries,
    branchCompareState: { kind: 'ready', result: branchCompareResult },
    branchCompareResult,
    busyAction: null,
    openingPath: null,
    openingBranchPath: null,
    openFile: vi.fn(async () => {}),
    openBranchDiff: vi.fn(async () => {}),
    runGitAction: vi.fn(async () => true),
    resolveConflict: vi.fn(async () => {}),
    setDiscardTarget: vi.fn()
  }
}

describe('source-control file virtualization in the mobile web page', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it.each([false, true])(
    'bounds mounted committed rows as the branch grows (dirty: %s)',
    async (dirty) => {
      const mountedCounts: number[] = []
      for (const count of [1_000, 20_000]) {
        const state = fileListState(count, dirty)
        await act(async () => {
          root.render(
            createElement(MobileSourceControlFileList, { key: count, state, bottomInset: 0 })
          )
        })
        const rows = container.querySelectorAll('[aria-label^="Open committed change "]')
        mountedCounts.push(rows.length)
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.length).toBeLessThan(50)
        expect(container.textContent).toContain(`${count} files vs main`)
        expect(
          container.querySelector('[aria-label="Open committed change src/committed-999.ts"]')
        ).toBeNull()
        if (dirty) {
          expect(
            container.querySelector('[aria-label="Open changed file src/uncommitted.ts"]')
          ).not.toBeNull()
        }
        const first = rows.item(0)
        if (!(first instanceof HTMLElement)) {
          throw new Error('No committed change mounted')
        }
        await act(async () => first.click())
        expect(state.openBranchDiff).toHaveBeenCalledExactlyOnceWith(state.branchEntries[0])
      }
      expect(mountedCounts[1]).toBe(mountedCounts[0])
    }
  )
})
