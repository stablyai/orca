import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import { WorkspaceOptionsSheet } from './workspace-options-sheet'

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
vi.mock('react-native-reanimated', async () =>
  (await import('../test-support/reanimated-pager-stub')).reanimatedPagerStub()
)
vi.mock('../components/bottom-drawer/keyed-bottom-drawer', () => ({
  KeyedBottomDrawer: ({ children }: { children: () => unknown }) => children()
}))
vi.mock('../components/MobileSearchField', () => ({ MobileSearchField: 'MobileSearchField' }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('./selectable-sidebar-sessions', () => ({
  useSelectableSidebarSessions: () => false,
  setSelectableSidebarSessions: vi.fn()
}))

describe('selectable sessions on the workspace options sheet', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('offers Select sessions on this phone', () => {
    const controller = {
      activeFilterCount: 0,
      projectOrderBy: 'manual',
      displayWorktrees: [],
      sectionsResult: { uniqueRepos: [] },
      settings: {
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
      },
      state: {
        view: {
          ...INITIAL_MOBILE_VIEW,
          filters: NO_WORKSPACE_ROW_FILTERS,
          groupBy: 'repo',
          sortBy: 'smart',
          sharesOtherClientFilter: false,
          newCardStyle: false
        },
        hostLabelById: new Map(),
        hostPlatform: null,
        repoHostIdByRepoId: new Map(),
        serverWorkspaces: { hosts: [], worktrees: [] },
        setShowWorkspaceOptions: vi.fn(),
        showWorkspaceOptions: true,
        worktrees: []
      }
    }
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
    const shown = renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
      .filter((child): child is string => typeof child === 'string')
    expect(shown).toContain('Select sessions')
    expect(shown).toContain('Taller rows you can tap to open that session.')
  })
})
