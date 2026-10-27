import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight'
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

import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import { WorkspaceOptionsSheet } from './workspace-options-sheet'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

type SheetOptions = { newCardStyle: boolean; hideSleeping: boolean; hasFolderRow?: boolean }

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
  const controller = {
    activeFilterCount: 0,
    projectOrderBy: 'manual',
    displayWorktrees: [],
    sectionsResult: {
      uniqueRepos: [
        { key: 'r1', id: 'r1', name: 'orca', color: '#fff' },
        { key: 'r2', id: 'r2', name: 'docs', color: '#000' }
      ]
    },
    settings,
    state: {
      view: {
        ...INITIAL_MOBILE_VIEW,
        filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: options.hideSleeping },
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

function sheet(options: SheetOptions, settings?: ReturnType<typeof buildController>['settings']) {
  const built = buildController(options)
  const controller = settings ? { ...built.controller, settings } : built.controller
  return createElement(WorkspaceOptionsSheet, {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these members.
    controller: controller as unknown as Parameters<typeof WorkspaceOptionsSheet>[0]['controller']
  })
}

function render(options: SheetOptions) {
  const { settings } = buildController(options)
  act(() => {
    renderer = create(sheet(options, settings))
  })
  return settings
}

const texts = () =>
  renderer!.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')

const press = (label: string) => {
  act(() => {
    renderer!.root
      .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label)
      .props.onPress()
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
    const settings = render({ newCardStyle: false, hideSleeping: false })
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
    const settings = render({ newCardStyle: false, hideSleeping: true })
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
    expect(settings.toggleRepoFilter).toHaveBeenCalledWith('r2')
    back()
    press('Show properties, 8')
    expect(texts()).not.toContain('Ports')
    press('Automation')
    expect(settings.toggleCardProperty).toHaveBeenCalledWith('automation')
    expect(settings.toggleCardProperty).not.toHaveBeenCalledWith('ports')
    press('Full list')
    expect(settings.setAgentActivityDisplayMode).toHaveBeenCalledWith('full')
  })
})
