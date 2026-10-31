import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  X: 'X'
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))
// The slide settles at once, so a back press unmounts the page in the same act.
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  runOnJS:
    <Args extends unknown[]>(fn: (...args: Args) => void) =>
    (...args: Args) =>
      fn(...args),
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (to: number, _config: unknown, done?: (finished: boolean) => void) => {
    done?.(true)
    return to
  }
}))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('../components/MobileSearchField', () => ({ MobileSearchField: 'MobileSearchField' }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))

import {
  buildFilterRepos,
  workspaceProjectFilterSelection,
  type WorkspaceSectionRepo
} from '../worktree/workspace-filter-repos'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import { WorkspaceOptionsSheet } from './workspace-options-sheet'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

type SheetOptions = {
  newCardStyle: boolean
  hideSleeping: boolean
  hasFolderRow?: boolean
  selected?: string[]
  repos?: WorkspaceSectionRepo[]
  activeFilterCount?: number
}

function buildController(options: SheetOptions) {
  const settings = {
    clearFilters: vi.fn(),
    handleGroupChange: vi.fn(),
    handleSortChange: vi.fn(),
    setAgentActivityDisplayMode: vi.fn(),
    setCardLayout: vi.fn(),
    setFilter: vi.fn(),
    setProjectOrderBy: vi.fn(),
    toggleCardProperty: vi.fn(),
    toggleRepoFilter: vi.fn(),
    pendingViewChanges: { pending: [], stale: false }
  }
  const uniqueRepos = options.repos ?? [
    { key: 'local|r1', id: 'r1', name: 'orca', color: '#fff' },
    { key: 'local|r2', id: 'r2', name: 'docs', color: '#000' }
  ]
  const controller = {
    activeFilterCount:
      options.activeFilterCount ??
      workspaceProjectFilterSelection(uniqueRepos, options.selected ?? []).badgeCount,
    projectOrderBy: 'manual',
    displayWorktrees: [],
    sectionsResult: {
      uniqueRepos
    },
    settings,
    state: {
      view: {
        ...INITIAL_MOBILE_VIEW,
        filters: {
          ...NO_WORKSPACE_ROW_FILTERS,
          filterRepoIds: options.selected ?? [],
          hideSleepingWorkspaces: options.hideSleeping
        },
        groupBy: 'repo',
        sortBy: 'smart',
        sharesOtherClientFilter: true,
        newCardStyle: options.newCardStyle
      },
      hostLabelById: new Map(),
      hostPlatform: null,
      repoHostIdByRepoId: new Map([['r2', 'ssh:box']]),
      serverWorkspaces: { hosts: [{ hostId: 'runtime:vm', label: 'VM' }], worktrees: [] },
      setShowWorkspaceOptions: vi.fn(),
      showWorkspaceOptions: true,
      worktrees: options.hasFolderRow ? [{ workspaceKind: 'folder-workspace' }] : []
    }
  }
  return { controller, settings }
}

function render(options: SheetOptions) {
  const { controller, settings } = buildController(options)
  act(() => {
    renderer = create(
      createElement(WorkspaceOptionsSheet, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these members.
        controller: controller as unknown as Parameters<
          typeof WorkspaceOptionsSheet
        >[0]['controller']
      })
    )
  })
  return { settings, state: controller.state }
}

const texts = () =>
  renderer!.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')

const pressable = (label: string) =>
  renderer!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
  )

const press = (label: string) => {
  act(() => {
    pressable(label).props.onPress()
  })
}

const back = () => press('Back to Workspace options')

const flip = (label: string, value: boolean) => {
  act(() => {
    renderer!.root
      .find((node) => String(node.type) === 'Switch' && node.props.accessibilityLabel === label)
      .props.onValueChange(value)
  })
}

describe('the phone Workspace options sheet', () => {
  it('swaps in Card display for the new card style and drops the exemption when nothing sleeps', () => {
    render({ newCardStyle: true, hideSleeping: false })
    const shown = texts()
    expect(shown).toContain('Card display')
    expect(shown).not.toContain('Card layout')
    expect(shown).not.toContain('Show properties')
    expect(shown).not.toContain('Except default branch')
    press('Card display')
    expect(texts()).toContain('Orca CLI')
    expect(texts()).toContain('Branch name')
    expect(texts()).not.toContain('Ports')
  })

  it('names the branch choice for folder paths too once the desktop has folder workspaces', () => {
    render({ newCardStyle: true, hideSleeping: false, hasFolderRow: true })
    press('Card display')
    expect(texts()).toContain('Branch / folder path')
  })

  it('opens an option page from its row, stays there after a pick, and goes back', () => {
    const { settings } = render({ newCardStyle: false, hideSleeping: false })
    expect(texts()).toContain('Card layout')
    expect(texts()).toContain('Show properties')
    expect(texts()).not.toContain('Card display')
    press('Sort by, Agent Activity')
    expect(texts()).toContain('Agents that need attention, then most recent activity.')
    press('Recent')
    expect(settings.handleSortChange).toHaveBeenCalledWith('recent')
    expect(texts()).toContain('Name')
    back()
    expect(texts()).toContain('Filters')
  })

  it('writes each control to the shared value it names', () => {
    const { settings } = render({ newCardStyle: false, hideSleeping: true })
    expect(texts()).toContain('Except default branch')
    flip('Hide CLI-created', true)
    expect(settings.setFilter).toHaveBeenCalledWith('hideCliCreatedWorkspaces', true)
    press('PR')
    expect(settings.handleGroupChange).toHaveBeenCalledWith('pr-status')
    press('Card layout, Detailed')
    press('Compact')
    expect(settings.setCardLayout).toHaveBeenCalledWith('compact')
    back()
    press('Project order, Manual')
    press('Recent')
    expect(settings.setProjectOrderBy).toHaveBeenCalledWith('recent')
    back()
    press('Hosts, All hosts')
    press('VM')
    expect(settings.setFilter).toHaveBeenCalledWith('visibleHostIds', ['runtime:vm'])
    back()
    press('Projects, All projects')
    press('docs')
    expect(settings.setFilter).toHaveBeenCalledWith('filterRepoIds', ['r2'])
    back()
    press('Show properties, 8')
    expect(texts()).not.toContain('Ports')
    press('Automation')
    expect(settings.toggleCardProperty).toHaveBeenCalledWith('automation')
    expect(settings.toggleCardProperty).not.toHaveBeenCalledWith('ports')
    press('Full list')
    expect(settings.setAgentActivityDisplayMode).toHaveBeenCalledWith('full')
  })
  it('resets filters only when some are active, and Done closes from the main sheet or a page', () => {
    const { settings, state } = render({
      newCardStyle: false,
      hideSleeping: false,
      activeFilterCount: 2
    })
    expect(texts()).toContain('Synced across your devices')
    press('Reset')
    expect(settings.clearFilters).toHaveBeenCalledTimes(1)
    press('Sort by, Agent Activity')
    const pageDone = renderer!.root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Done'
    )
    act(() => pageDone.at(-1)?.props.onPress())
    expect(state.setShowWorkspaceOptions).toHaveBeenCalledWith(false)
    act(() => renderer?.unmount())
    render({ newCardStyle: false, hideSleeping: false })
    expect(pressable('Reset').props.disabled).toBe(true)
  })
})

it('shows partial and unavailable owner membership with a floor badge and exact All projects clear', () => {
  const repos = ['a', 'b'].map((id) => ({
    id,
    displayName: 'App',
    path: `/${id}`,
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }))
  const projection = projectHostSetupProjectionFromRepos(repos)
  const options = buildFilterRepos(repos, [], {
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  const selected = ['a', 'offline']
  const { settings } = render({
    newCardStyle: false,
    hideSleeping: false,
    selected,
    repos: options
  })
  expect(texts()).toContain('App · Partially selected · Unavailable projects')
  press('Projects, App · Partially selected · Unavailable projects')
  expect(texts()).toContain('Partially selected')
  expect(texts()).toContain('Saved project selection · Unavailable projects')
  const app = renderer!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'App'
  )
  expect(app.props.accessibilityState.checked).toBe(false)
  press('App')
  expect(settings.setFilter).toHaveBeenLastCalledWith('filterRepoIds', ['offline', 'a', 'b'])
  press('All projects')
  expect(settings.setFilter).toHaveBeenLastCalledWith('filterRepoIds', [])
  expect(selected).toEqual(['a', 'offline'])
})

it.each([[[]], [[{ key: 'local|a', id: 'a', name: 'App', color: '#fff' }]]])(
  'keeps offline-only restriction clearable through an empty or one-project phone catalog (%j)',
  (...[repos]) => {
    const { settings } = render({
      newCardStyle: false,
      hideSleeping: false,
      selected: ['offline'],
      repos
    })
    expect(texts()).toContain('Saved project selection · Unavailable projects')
    press('Projects, Saved project selection · Unavailable projects')
    press('All projects')
    expect(settings.setFilter).toHaveBeenCalledWith('filterRepoIds', [])
  }
)

it.each([100, 1000])(
  'bounds actual phone Projects summary, page and search membership visits for %i groups',
  (count) => {
    const repos = Array.from({ length: count }, (_, group) =>
      ['a', 'b'].map((checkout) => ({
        id: `${group}-${checkout}`,
        path: `/${group}/${checkout}`,
        displayName: `App ${group}`,
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: `app-${group}` }
      }))
    ).flat()
    const projection = projectHostSetupProjectionFromRepos(repos)
    const options = buildFilterRepos(repos, [], {
      projects: projection.projects,
      projectHostSetups: projection.setups
    })
    const selected = Array.from({ length: count }, (_, group) => `${group}-a`)
    let visits = 0
    const includes = Array.prototype.includes
    const has = Set.prototype.has
    const includeSpy = vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
      this: unknown[],
      value: unknown,
      from?: number
    ) {
      if (typeof value === 'string' && value.startsWith('project:')) {
        visits += this.length
      }
      return includes.call(this, value, from)
    })
    const hasSpy = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (typeof value === 'string' && value.startsWith('project:')) {
        visits++
      }
      return has.call(this, value)
    })
    try {
      render({ newCardStyle: false, hideSleeping: false, selected, repos: options })
      expect(texts()).toContain(`${count} projects · Partially selected`)
      expect(visits).toBeGreaterThanOrEqual(count)
      expect(visits).toBeLessThan(40 * count)
      visits = 0
      press(`Projects, ${count} projects · Partially selected`)
      expect(
        renderer!.root.findAll(
          (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'checkbox'
        )
      ).toHaveLength(count + 1)
      expect(visits).toBeGreaterThanOrEqual(count)
      expect(visits).toBeLessThan(40 * count)
      visits = 0
      act(() =>
        renderer!.root
          .find((node) => String(node.type) === 'MobileSearchField')
          .props.onChangeText('App 99')
      )
      expect(visits).toBeLessThan(20 * count)
      press('All projects')
    } finally {
      includeSpy.mockRestore()
      hasSpy.mockRestore()
    }
  }
)
