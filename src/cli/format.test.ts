import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatAutomationShow,
  formatComputerAction,
  formatTerminalList,
  formatWorktreeList,
  printResult
} from './format'
import type { ComputerActionResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { Automation } from '../shared/automations/automation-definition'

let testScreenshotDir: string | null = null

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR
  if (testScreenshotDir) {
    rmSync(testScreenshotDir, { recursive: true, force: true })
    testScreenshotDir = null
  }
})

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

    const [parent, child] = output.split('\n\n')
    expect(parent).toContain('repo::/tmp/repo/parent  feature/parent')
    expect(parent).toContain('parentWorktreeId: null')
    expect(parent).toContain('childWorktreeIds: repo::/tmp/repo/child')
    expect(child).toContain('repo::/tmp/repo/child  feature/child')
    expect(child).toContain('parentWorktreeId: repo::/tmp/repo/parent')
    expect(child).toContain('childWorktreeIds: []')
  })
})

describe('formatAutomationShow', () => {
  function automation(overrides: Partial<Automation> = {}): Automation {
    return {
      id: 'auto-1',
      name: 'Nightly',
      prompt: 'Run checks',
      precheck: null,
      agentId: 'codex',
      projectId: 'repo-legacy',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'new_per_run',
      workspaceId: null,
      baseBranch: null,
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: 0,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 720,
      createdAt: 0,
      updatedAt: 0,
      ...overrides
    }
  }

  it('shows explicit run context before the legacy repo id', () => {
    const output = formatAutomationShow({
      automation: automation({
        runContext: {
          kind: 'workspace-run',
          projectId: 'github:stablyai/orca',
          hostId: 'runtime:gpu',
          projectHostSetupId: 'setup-gpu',
          repoId: 'repo-gpu',
          path: '/srv/orca'
        }
      })
    })

    expect(output).toContain('runProjectId: github:stablyai/orca')
    expect(output).toContain('runHostId: runtime:gpu')
    expect(output).toContain('projectHostSetupId: setup-gpu')
    expect(output).toContain('runRepoId: repo-gpu')
    expect(output).toContain('runPath: /srv/orca')
    expect(output).toContain('legacyRepoId: repo-legacy')
    expect(output).not.toContain('projectId: repo-legacy')
  })
})

describe('formatTerminalList', () => {
  it('prints visual split groups and nested terminal panes', () => {
    const output = formatTerminalList({
      terminals: [
        {
          handle: 'term_left',
          ptyId: 'pty-left',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          branch: 'main',
          tabId: 'tab-left',
          leafId: 'leaf-left',
          title: 'Left',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: ''
        },
        {
          handle: 'term_top',
          ptyId: 'pty-top',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          branch: 'main',
          tabId: 'tab-right',
          leafId: 'leaf-top',
          title: 'Right top',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: ''
        },
        {
          handle: 'term_bottom',
          ptyId: 'pty-bottom',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          branch: 'main',
          tabId: 'tab-right',
          leafId: 'leaf-bottom',
          title: 'Right bottom',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: ''
        }
      ],
      totalCount: 3,
      truncated: false,
      visualLayouts: [
        {
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          root: {
            type: 'split',
            direction: 'horizontal',
            first: {
              type: 'group',
              groupId: 'group-left',
              activeTabId: 'tab-left',
              tabs: [
                {
                  tabId: 'tab-left',
                  title: 'Left',
                  activeLeafId: 'leaf-left',
                  panes: {
                    type: 'terminal',
                    handle: 'term_left',
                    tabId: 'tab-left',
                    leafId: 'leaf-left',
                    title: 'Left',
                    connected: true,
                    active: true
                  }
                }
              ]
            },
            second: {
              type: 'group',
              groupId: 'group-right',
              activeTabId: 'tab-right',
              tabs: [
                {
                  tabId: 'tab-right',
                  title: 'Right',
                  activeLeafId: 'leaf-bottom',
                  panes: {
                    type: 'pane-split',
                    direction: 'vertical',
                    first: {
                      type: 'terminal',
                      handle: 'term_top',
                      tabId: 'tab-right',
                      leafId: 'leaf-top',
                      title: 'Right top',
                      connected: true,
                      active: false
                    },
                    second: {
                      type: 'terminal',
                      handle: 'term_bottom',
                      tabId: 'tab-right',
                      leafId: 'leaf-bottom',
                      title: 'Right bottom',
                      connected: true,
                      active: true
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    } as never)

    expect(output).toContain('visual layout:')
    expect(output).toContain('/repo')
    expect(output).toContain('split horizontal')
    expect(output).toContain('group group-left')
    expect(output).toContain('tab tab-left  Left')
    expect(output).toContain('* term_left  Left  tab=tab-left leaf=leaf-left')
    expect(output).toContain('group group-right')
    expect(output).toContain('pane split vertical')
    expect(output).toContain('  term_top  Right top  tab=tab-right leaf=leaf-top')
    expect(output).toContain('* term_bottom  Right bottom  tab=tab-right leaf=leaf-bottom')
  })
})

describe('formatComputerAction', () => {
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

  it('uses snapshot window index for follow-up commands when the provider has no stable window id', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Linux Browser', bundleId: null, pid: 100 },
        window: { title: 'Inbox', id: null, index: 2, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'synthetic',
        targetWindowId: null
      }
    }

    const output = formatComputerAction('click', result)

    const app = process.platform === 'win32' ? '"Linux Browser"' : "'Linux Browser'"
    expect(output).toContain(`Use \`orca computer get-app-state --app ${app} --window-index 2\``)
    expect(output).not.toContain('--window-id')
  })

  it('uses action target window index before snapshot fallback for ID-less providers', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Linux Browser', bundleId: null, pid: 100 },
        window: { title: 'Inbox', id: null, index: 4, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'synthetic',
        targetWindowId: null,
        targetWindowIndex: 2
      }
    }

    const output = formatComputerAction('click', result)

    const app = process.platform === 'win32' ? '"Linux Browser"' : "'Linux Browser'"
    expect(output).toContain(`Use \`orca computer get-app-state --app ${app} --window-index 2\``)
    expect(output).not.toContain('--window-index 4')
    expect(output).not.toContain('--window-id')
  })
})

describe('printResult computer screenshots', () => {
  it('skips screenshot temp cleanup when the cleanup marker is fresh', () => {
    testScreenshotDir = mkdtempSync(join(tmpdir(), 'orca-format-test-'))
    const expiredPath = join(testScreenshotDir, 'old-screenshot.png')
    writeFileSync(expiredPath, 'old')
    const expired = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(expiredPath, expired, expired)
    writeFileSync(join(testScreenshotDir, '.last-cleanup'), 'recent\n')
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = testScreenshotDir
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    printResult(
      {
        id: 'req/1',
        ok: true,
        result: {
          screenshot: {
            data: Buffer.from('png-data').toString('base64'),
            format: 'png',
            width: 1,
            height: 1,
            scale: 1
          },
          screenshotStatus: { state: 'captured' }
        },
        _meta: { runtimeId: 'runtime-1' }
      },
      true,
      () => 'unused'
    )

    expect(existsSync(expiredPath)).toBe(true)
    const output: {
      result: { screenshot: { dataOmitted: boolean; path: string } }
    } = JSON.parse(logSpy.mock.calls[0][0])
    expect(output.result.screenshot.dataOmitted).toBe(true)
    expect(output.result.screenshot.path).toContain('req_1-screenshot.png')
    expect(readFileSync(output.result.screenshot.path, 'utf8')).toBe('png-data')
  })

  it('keeps inline screenshot data when temp export fails', () => {
    testScreenshotDir = join(tmpdir(), `orca-format-blocked-${Date.now()}`)
    writeFileSync(testScreenshotDir, 'not-a-directory')
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = testScreenshotDir
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const screenshotData = Buffer.from('png-data').toString('base64')

    printResult(
      {
        id: 'req-export-fail',
        ok: true,
        result: {
          screenshot: {
            data: screenshotData,
            format: 'png',
            width: 1,
            height: 1,
            scale: 1
          },
          screenshotStatus: { state: 'captured' }
        },
        _meta: { runtimeId: 'runtime-1' }
      },
      true,
      () => 'unused'
    )

    const output = JSON.parse(logSpy.mock.calls[0][0]) as {
      result: { screenshot: { data: string; path?: string; dataOmitted?: boolean } }
    }
    expect(output.result.screenshot.data).toBe(screenshotData)
    expect(output.result.screenshot.path).toBeUndefined()
    expect(output.result.screenshot.dataOmitted).toBeUndefined()
  })

  it('does not rewrite non-computer nested screenshot JSON payloads', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const screenshotData = Buffer.from('png-data').toString('base64')

    printResult(
      {
        id: 'req-browser-like',
        ok: true,
        result: {
          screenshot: {
            data: screenshotData,
            format: 'png'
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      },
      true,
      () => 'unused'
    )

    const output = JSON.parse(logSpy.mock.calls[0][0]) as {
      result: { screenshot: { data: string; path?: string; dataOmitted?: boolean } }
    }
    expect(output.result.screenshot.data).toBe(screenshotData)
    expect(output.result.screenshot.path).toBeUndefined()
    expect(output.result.screenshot.dataOmitted).toBeUndefined()
  })
})
