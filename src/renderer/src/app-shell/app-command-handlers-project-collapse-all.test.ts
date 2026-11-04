// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { computeRenderedSidebarRows } from '../components/sidebar/worktree-list/listing/rendered-sidebar-worktree-order'
import { computeVisibleWorktrees } from '../components/sidebar/worktree-list/listing/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '../components/sidebar/worktree-list/listing/visible-worktree-options-from-state'
import {
  repo,
  worktree
} from '../components/sidebar/worktree-list/grouping/worktree-list-groups-test-fixtures'
import {
  createAppCommandHandlers,
  type AppShortcutState,
  type ShortcutDispatchInput
} from './app-command-handlers'

const mocks = vi.hoisted(() => ({ notifyTerminalCapture: vi.fn() }))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: mocks.notifyTerminalCapture
}))

const initialState = useAppStore.getInitialState()
const otherRepo: Repo = { ...repo, id: 'repo-other', path: '/tmp/other', displayName: 'other' }
const otherWorktree: Worktree = {
  ...worktree,
  id: 'wt-other',
  repoId: otherRepo.id,
  path: '/tmp/other-feature'
}
const uiSet = vi.fn().mockResolvedValue(undefined)

function seed(overrides: Partial<AppState> = {}): void {
  useAppStore.setState(
    {
      ...initialState,
      repos: [repo, otherRepo],
      worktreesByRepo: { [repo.id]: [worktree], [otherRepo.id]: [otherWorktree] },
      showSleepingWorkspaces: true,
      filterRepoIds: [],
      groupBy: 'repo',
      sidebarOpen: false,
      ...overrides
    },
    true
  )
}

function renderedWorktreeIds(): string[] {
  const state = useAppStore.getState()
  const visible = computeVisibleWorktrees(
    state.worktreesByRepo,
    [],
    buildVisibleWorktreeOptionsFromState(state, new Map(state.repos.map((r) => [r.id, r])))
  )
  return computeRenderedSidebarRows(state, visible).flatMap((row) =>
    row.type === 'item' ? [row.worktree.id] : []
  )
}

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: null,
    actions: {
      toggleSidebar: vi.fn(),
      toggleRightSidebar: vi.fn(),
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn(),
      showRightSidebarFiles: vi.fn(),
      showRightSidebarSearch: vi.fn(),
      openDiffNotesSendMenuForActiveWorktree: vi.fn()
    },
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true
  }
}

function runToggle(input: ShortcutDispatchInput, context: 'app' | 'terminal' = 'app') {
  return createAppCommandHandlers(shortcutState(), input, context).get(
    'sidebar.projects.toggleCollapseAll'
  )?.()
}

function shortcutInput(): ShortcutDispatchInput {
  return { target: null, defaultPrevented: false, preventDefault: vi.fn() }
}

describe('collapse / expand all projects app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { ui: { set: uiSet } } })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('collapses every project, then expands them all again', () => {
    seed()
    expect(renderedWorktreeIds()).toEqual([worktree.id, otherWorktree.id])

    expect(runToggle(shortcutInput())).toBe(true)
    expect(renderedWorktreeIds()).toEqual([])
    expect(useAppStore.getState().sidebarOpen).toBe(false)
    expect(uiSet).toHaveBeenLastCalledWith({
      collapsedGroups: [...useAppStore.getState().collapsedGroups]
    })

    expect(runToggle(shortcutInput())).toBe(true)
    expect(renderedWorktreeIds()).toEqual([worktree.id, otherWorktree.id])
    expect(useAppStore.getState().collapsedGroups.size).toBe(0)
    expect(useAppStore.getState().sidebarOpen).toBe(true)
    expect(uiSet).toHaveBeenLastCalledWith({ collapsedGroups: [] })
  })

  it('collapses the rest when only some projects are expanded', () => {
    seed()
    runToggle(shortcutInput())
    const allCollapsed = new Set(useAppStore.getState().collapsedGroups)
    const [firstKey] = allCollapsed
    useAppStore.getState().toggleCollapsedGroup(firstKey ?? '')
    expect(renderedWorktreeIds()).toHaveLength(1)

    expect(runToggle(shortcutInput())).toBe(true)
    expect(useAppStore.getState().collapsedGroups).toEqual(allCollapsed)
    expect(renderedWorktreeIds()).toEqual([])
  })

  it('leaves projects under a collapsed host section alone', () => {
    const sshRepos = [repo, { ...otherRepo, connectionId: 'box' }]
    seed({
      repos: sshRepos,
      sshTargetLabels: new Map([['box', 'Box']]),
      visibleWorkspaceHostIds: ['local', 'ssh:box'],
      collapsedGroups: new Set(['host:ssh:box'])
    })
    expect(renderedWorktreeIds()).toEqual([worktree.id])

    expect(runToggle(shortcutInput())).toBe(true)
    const collapsed = useAppStore.getState().collapsedGroups
    expect(renderedWorktreeIds()).toEqual([])
    expect(collapsed.has('host:ssh:box')).toBe(true)
    expect(collapsed.size).toBe(2)

    expect(runToggle(shortcutInput())).toBe(true)
    expect(useAppStore.getState().collapsedGroups).toEqual(new Set(['host:ssh:box']))
    expect(renderedWorktreeIds()).toEqual([worktree.id])
  })

  it('expands a visible collapsed project group whose projects sit under a collapsed host', () => {
    const group: ProjectGroup = {
      id: 'g1',
      name: 'Group',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0
    }
    seed({
      repos: [repo, { ...otherRepo, connectionId: 'box', projectGroupId: group.id }],
      projectGroups: [group],
      sshTargetLabels: new Map([['box', 'Box']]),
      visibleWorkspaceHostIds: ['local', 'ssh:box'],
      collapsedGroups: new Set(['host:ssh:box', 'project-group:g1', 'project:repo:repo-1'])
    })
    expect(renderedWorktreeIds()).toEqual([])

    expect(runToggle(shortcutInput())).toBe(true)
    expect(useAppStore.getState().collapsedGroups).toEqual(new Set(['host:ssh:box']))
    expect(renderedWorktreeIds()).toEqual([worktree.id])
  })

  it('lets the chord through when the sidebar is not grouped by project', () => {
    seed({ groupBy: 'none' })
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(useAppStore.getState().collapsedGroups.size).toBe(0)
    expect(uiSet).not.toHaveBeenCalled()
  })

  it('lets a modal keep its keyboard input', () => {
    seed({ activeModal: 'delete-worktree' })
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(useAppStore.getState().collapsedGroups.size).toBe(0)
  })

  it('lets a focused menu keep its keyboard input', () => {
    seed()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.append(item)
    document.body.append(menu)
    item.focus()
    const input = shortcutInput()

    try {
      expect(runToggle(input)).toBe(false)
      expect(input.preventDefault).not.toHaveBeenCalled()
      expect(useAppStore.getState().collapsedGroups.size).toBe(0)
    } finally {
      menu.remove()
    }
  })

  it('reports a claimed terminal shortcut through the existing notification policy', () => {
    seed()
    expect(runToggle(shortcutInput(), 'terminal')).toBe(true)
    expect(mocks.notifyTerminalCapture).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'sidebar.projects.toggleCollapseAll' })
    )
  })
})
