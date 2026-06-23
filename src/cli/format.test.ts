import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteCliCommandArgument } from './shell-command-quote'
import { RuntimeRpcFailureError } from './runtime-client'
import {
  formatCliError,
  formatAutomationShow,
  formatComputerAction,
  formatGetAppState,
  formatTerminalList,
  formatTerminalRead,
  formatWorktreeList,
  printResult
} from './format'
import type { ComputerActionResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { Automation } from '../shared/automations-types'

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

describe('formatCliError', () => {
  it('prints structured computer-use startup recovery steps', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: {
        code: 'app_not_found',
        message: 'app not found: Gmail',
        data: {
          nextSteps: [
            'Run `orca computer list-apps --json` and retry with the exact app name or bundle ID.',
            'If the target is a website or web app such as Gmail, choose the desktop browser app/window that contains it; `orca computer` app selectors refer to desktop apps, not website names.',
            'Do not retry the same `orca computer ... --app <web app>` command unchanged.',
            'If the desired browser is not listed, open or focus that browser first, then retry `orca computer list-apps --json` and `orca computer list-windows --app <browser> --json`.'
          ]
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    const output = formatCliError(error)

    expect(output).toContain('app not found: Gmail')
    expect(output).toContain('Next step: Run `orca computer list-apps --json`')
    expect(output).toContain('desktop browser app/window')
    expect(output).toContain('--app <web app>')
    expect(output).not.toContain('orca goto')
  })

  it('prints runtime next steps for structured lineage errors', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: {
        code: 'LINEAGE_PARENT_NOT_FOUND',
        message: 'Parent selector was not found.',
        data: {
          nextSteps: [
            'Pass a valid --parent-worktree selector such as folder:<id>, worktree:<id>, id:<worktreeId>, branch:<branch>, issue:<number>, path:<absolute-path>, or active/current.',
            'Retry with --no-parent to create without lineage.',
            123
          ]
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    expect(formatCliError(error)).toBe(
      [
        'Parent selector was not found.',
        'Next step: Pass a valid --parent-worktree selector such as folder:<id>, worktree:<id>, id:<worktreeId>, branch:<branch>, issue:<number>, path:<absolute-path>, or active/current.',
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
      `Use \`orca computer get-app-state --app ${quoteCliCommandArgument('Text Editor')} --worktree id:repo::/tmp/repo --window-id 99\``
    )
    expect(output).toContain('5 visible elements in current window')
    expect(output).toContain(
      'Use the --json result or rerun state before choosing the next element index.'
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

  it('surfaces action screenshot failures in pretty output', () => {
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
      screenshotStatus: {
        state: 'failed',
        code: 'screenshot_failed',
        message:
          'screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window'
      },
      action: {
        path: 'synthetic',
        targetWindowId: 42
      }
    }

    const output = formatComputerAction('click', result)

    expect(output).toContain('Click attempted via synthetic, unverified (synthetic input)')
    expect(output).toContain('Screenshot failed (screenshot_failed)')
    expect(output).toContain('payload cap')
    expect(output).toContain(
      'Use `orca computer get-app-state --app com.apple.finder --window-id 42`'
    )
    expect(output).not.toContain('Click completed')
  })

  it('does not treat clipboard actions without verification as completed', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Finder', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'clipboard',
        actionName: 'paste',
        targetWindowId: 42
      }
    }

    const output = formatComputerAction('paste-text', result)

    expect(output).toContain('Paste Text attempted via clipboard, unverified (clipboard paste)')
    expect(output).toContain('Inspect with the command above')
    expect(output).not.toContain('Paste Text completed')
  })

  it('respects explicit verification metadata on synthetic action results', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Automation Harness', bundleId: null, pid: 100 },
        window: { title: 'Harness', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'synthetic',
        actionName: 'typeText',
        targetWindowId: 42,
        verification: {
          state: 'verified',
          property: 'focusedText',
          expected: 'draft body',
          actualPreview: 'draft body'
        }
      }
    }

    const output = formatComputerAction('type-text', result)

    expect(output).toContain('Type Text completed via synthetic, verified focusedText')
    expect(output).not.toContain('Type Text attempted')
    expect(output).not.toContain('unverified (synthetic input)')
  })

  it('drops stale requested window selectors after a window-changed fallback', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Replacement', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'synthetic',
        targetWindowId: 42,
        verification: { state: 'unverified', reason: 'window_changed' }
      }
    }

    const output = formatComputerAction('click', result, {
      session: 'manual',
      windowIndex: 1
    })

    expect(output).toContain(
      'Use `orca computer get-app-state --app com.apple.finder --session manual --window-id 42`'
    )
    expect(output).toContain('Click attempted via synthetic, unverified (window changed)')
    expect(output).toContain(
      'Inspect with the command above or use the --json result before assuming it worked.'
    )
    expect(output).not.toContain('Click completed')
    expect(output).not.toContain('--window-index 1')
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

    expect(output).toContain(
      `Use \`orca computer get-app-state --app ${quoteCliCommandArgument('Linux Browser')} --window-index 2\``
    )
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

    expect(output).toContain(
      `Use \`orca computer get-app-state --app ${quoteCliCommandArgument('Linux Browser')} --window-index 2\``
    )
    expect(output).not.toContain('--window-index 4')
    expect(output).not.toContain('--window-id')
  })
})

describe('printResult computer screenshots', () => {
  it('shows screenshot dimensions and coordinate scale in pretty state output', () => {
    const output = formatGetAppState({
      snapshot: {
        id: 'snap-test',
        app: { name: 'Editor', bundleId: null, pid: 123 },
        window: { title: 'Editor', id: null, index: 2, width: 1200, height: 800 },
        coordinateSpace: 'window',
        treeText: 'App=Editor (pid 123)',
        elementCount: 1,
        focusedElementId: null,
        truncation: { truncated: false }
      },
      screenshot: {
        data: Buffer.from('png-data').toString('base64'),
        format: 'png',
        width: 600,
        height: 400,
        scale: 0.5
      },
      screenshotStatus: { state: 'captured' }
    })

    expect(output).toContain('Screenshot captured (png')
    expect(output).toContain('600x400')
    expect(output).toContain('coordinate x/y = screenshot pixels / 0.5')
    expect(output).toContain('Window: index:2 "Editor"')
    expect(output).toContain('Visible elements: 1')
    expect(output).not.toContain('Elements: 1')
  })

  it('removes expired screenshot temp files when cleanup is due', () => {
    testScreenshotDir = mkdtempSync(join(tmpdir(), 'orca-format-test-'))
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = testScreenshotDir
    const expiredPath = join(testScreenshotDir, 'old-screenshot.png')
    writeFileSync(expiredPath, 'old')
    const expired = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(expiredPath, expired, expired)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    printResult(
      {
        id: 'req-cleanup',
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

    expect(existsSync(expiredPath)).toBe(false)
    expect(existsSync(join(testScreenshotDir, '.last-cleanup'))).toBe(true)
    expect(logSpy).toHaveBeenCalled()
  })

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
    const output = JSON.parse(logSpy.mock.calls[0][0]) as {
      result: { screenshot: { dataOmitted: boolean; path: string } }
    }
    expect(output.result.screenshot.dataOmitted).toBe(true)
    expect(output.result.screenshot.path).toContain('req_1-screenshot.png')
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
