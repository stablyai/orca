import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import type { AutomationRun } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/orca',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git'
}

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-2222-4333-8444-555555555555'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const WORKTREE_ID = '/tmp/orca::wt1'

function makeStore() {
  return {
    getRepos: vi.fn(() => [repo]),
    listAutomations: vi.fn(() => []),
    listAutomationRuns: vi.fn(() => []),
    getSettings: vi.fn(() => ({
      workspaceDir: '/tmp',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      branchPrefixCustom: ''
    })),
    getAllWorktreeMeta: vi.fn(() => new Map()),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getGitHubCache: vi.fn()
  }
}

const retainedRun = {
  id: 'run-1',
  automationId: 'auto-1',
  terminalPaneKey: PANE_KEY,
  status: 'dispatched'
} as unknown as AutomationRun

describe('resolving an automation run terminal across startup states', () => {
  it('cannot answer for any pane while no graph has published', () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)

    expect(observer.resolveRunTerminal(retainedRun)).toBeNull()
  })

  it('still cannot answer once an explicitly empty headless graph publishes', () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)

    expect(observer.resolveRunTerminal(retainedRun)).toBeNull()
  })

  it('answers from an adopted PTY bound to the pane, with no leaves at all', () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty('pty-1', WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)

    expect(observer.resolveRunTerminal(retainedRun)).toBeTruthy()
  })

  it('answers only after the pane binds, so an early lookup is not a lost terminal', () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)

    expect(observer.resolveRunTerminal(retainedRun)).toBeNull()
    runtime.registerPty('pty-1', WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    expect(observer.resolveRunTerminal(retainedRun)).toBeTruthy()
  })
})
