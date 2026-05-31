import { describe, expect, it } from 'vitest'
import { RuntimeRpcFailureError } from './runtime-client'
import {
  formatCliError,
  formatComputerAction,
  formatTerminalRead,
  formatWorktreeList
} from './format'
import type { ComputerActionResult, RuntimeWorktreeRecord } from '../shared/runtime-types'

function worktree(overrides: Partial<RuntimeWorktreeRecord> = {}): RuntimeWorktreeRecord {
  const base: RuntimeWorktreeRecord = {
    id: 'repo::/tmp/repo/child',
    repoId: 'repo',
    path: '/tmp/repo/child',
    head: 'abc123',
    branch: 'feature/child',
    isBare: false,
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    git: {
      path: '/tmp/repo/child',
      head: 'abc123',
      branch: 'feature/child',
      isBare: false,
      isMainWorktree: false
    },
    displayName: '',
    comment: ''
  }
  return { ...base, ...overrides }
}

describe('formatCliError', () => {
  it('prints runtime next steps for structured lineage errors', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: {
        code: 'LINEAGE_PARENT_NOT_FOUND',
        message: 'Parent workspace was not found.',
        data: {
          nextSteps: [
            'Run `orca worktree list` and pass a valid --parent-worktree selector.',
            'Retry with --no-parent to create without lineage.',
            123
          ]
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    expect(formatCliError(error)).toBe(
      [
        'Parent workspace was not found.',
        'Next step: Run `orca worktree list` and pass a valid --parent-worktree selector.',
        'Next step: Retry with --no-parent to create without lineage.'
      ].join('\n')
    )
  })
})

describe('formatWorktreeList', () => {
  it('includes parent and child workspace relationships in text output', () => {
    const output = formatWorktreeList({
      worktrees: [
        worktree({
          id: 'repo::/tmp/repo/parent',
          path: '/tmp/repo/parent',
          branch: 'feature/parent',
          childWorktreeIds: ['repo::/tmp/repo/child']
        }),
        worktree({
          parentWorktreeId: 'repo::/tmp/repo/parent'
        })
      ],
      totalCount: 2,
      truncated: false
    })

    expect(output).toContain('parentWorktreeId: null')
    expect(output).toContain('childWorktreeIds: repo::/tmp/repo/child')
    expect(output).toContain('parentWorktreeId: repo::/tmp/repo/parent')
    expect(output).toContain('childWorktreeIds: []')
  })
})

describe('formatTerminalRead', () => {
  it('warns limited cursor reads to continue with the next cursor', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: ['line 1'],
        truncated: false,
        limited: true,
        oldestCursor: '0',
        nextCursor: '50',
        latestCursor: '150',
        returnedLineCount: 1
      }
    })

    expect(output).toContain('cursor: 50')
    expect(output).toContain('oldest cursor: 0')
    expect(output).toContain('latest cursor: 150')
    expect(output).toContain('warning: output limited; continue with --cursor 50')
  })

  it('warns limited tail previews to page retained output from the oldest cursor', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: ['line 100'],
        truncated: false,
        limited: true,
        oldestCursor: '0',
        nextCursor: '150',
        latestCursor: '150',
        returnedLineCount: 1
      }
    })

    expect(output).toContain('cursor: 150')
    expect(output).toContain('oldest cursor: 0')
    expect(output).toContain('latest cursor: 150')
    expect(output).toContain(
      'warning: output limited; page retained output with --cursor 0 --limit <count>'
    )
  })

  it('uses a generic limited warning when only partial output is retained', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: [],
        truncated: false,
        limited: true,
        oldestCursor: '150',
        nextCursor: '150',
        latestCursor: '150',
        returnedLineCount: 0
      }
    })

    expect(output).toContain('cursor: 150')
    expect(output).toContain('oldest cursor: 150')
    expect(output).toContain('latest cursor: 150')
    expect(output).toContain('warning: output limited')
    expect(output).not.toContain('page retained output')
  })

  it('keeps older runtime read responses readable', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: ['old server output'],
        truncated: true,
        nextCursor: '12'
      }
    })

    expect(output).toContain('cursor: 12')
    expect(output).toContain('warning: older output is no longer retained')
    expect(output).toContain('old server output')
    expect(output).not.toContain('undefined')
  })
})

describe('formatComputerAction', () => {
  it('includes routed worktree and explicit window target in the suggested follow-up command', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Text Editor', bundleId: null, pid: 100 },
        window: { title: 'Document', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'accessibility',
        targetWindowId: 41
      }
    }

    const output = formatComputerAction('click', result, {
      worktree: 'id:repo::/tmp/repo',
      windowId: 99
    })

    expect(output).toContain(
      "Use `orca computer get-app-state --app 'Text Editor' --worktree id:repo::/tmp/repo --window-id 99`"
    )
  })

  it('preserves explicit window-index targeting in the suggested follow-up command', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Document', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
    }

    const output = formatComputerAction('click', result, {
      session: 'manual',
      windowIndex: 1
    })

    expect(output).toContain(
      'Use `orca computer get-app-state --app com.apple.finder --session manual --window-index 1`'
    )
  })
})
