import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { colors, spacing } from '../theme/mobile-theme'
import type { HostScreenController } from './use-host-screen-controller'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostScreenOverlays } from './host-screen-overlays'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Moon: 'Moon'
}))

vi.mock('../platform/external-link', () => ({ openExternalLink: () => {} }))
vi.mock('../agent-history/worktree-navigation-actions', () => ({
  buildWorktreeNavigationActions: () => []
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetContent: () => null }))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children?: unknown }) => children
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../components/NewWorktreeModalController', () => ({
  NewWorktreeModalController: () => null
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))

function controllerWith(
  hideSleeping: boolean,
  alwaysShowDefaultBranch = true
): HostScreenController {
  const fields = {
    actions: {
      handleDeleteWorktree: () => {},
      handleRemoveHost: () => {},
      navigateFromHostList: () => {},
      setShowNewWorktreeVisible: () => {},
      togglePin: () => {}
    },
    catalog: { fetchWorktrees: () => {} },
    client: null,
    existingWorktreePaths: [],
    hostCapabilities: [],
    hostId: 'host-1',
    sectionsResult: { uniqueRepos: [] },
    settings: {
      activeFilterCount: 0,
      clearFilters: () => {},
      handleGroupChange: () => {},
      handleSortChange: () => {},
      toggleAlwaysShowDefaultBranch: () => {},
      toggleHideDefaultBranch: () => {},
      toggleHideSleeping: () => {},
      toggleRepoFilter: () => {}
    },
    showNewWorktree: false,
    state: {
      actionTarget: null,
      confirmDelete: null,
      confirmRemoveHost: false,
      filters: {
        alwaysShowDefaultBranch,
        filterRepoIds: new Set<string>(),
        hideDefaultBranch: false,
        hideSleeping
      },
      groupMode: 'none',
      hostName: 'Desk',
      newWorktreeModalRef: { current: null },
      newWorktreeModalVisibleRef: { current: false },
      setActionTarget: () => {},
      setConfirmDelete: () => {},
      setConfirmRemoveHost: () => {},
      setShowFilterModal: () => {},
      setShowGroupPicker: () => {},
      setShowSortPicker: () => {},
      showFilterModal: true,
      showGroupPicker: false,
      showSortPicker: false,
      sortMode: 'recent',
      worktrees: []
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the filter sheet reads only these members; the rest of the controller is not reached while the action target is closed.
  return fields as unknown as HostScreenController
}

function renderFilters(hideSleeping: boolean, alwaysShowDefaultBranch = true): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(
      createElement(HostScreenOverlays, {
        controller: controllerWith(hideSleeping, alwaysShowDefaultBranch)
      })
    )
  })
  if (!renderer) {
    throw new Error('filter sheet did not render')
  }
  return renderer
}

const exceptionLabel = 'Keep the default branch visible while hiding sleeping workspaces'

describe('Hide sleeping default-branch exception', () => {
  it('renders as an indented muted child of Hide sleeping, not a peer row', () => {
    const renderer = renderFilters(true)
    const exception = renderer.root.findByProps({ accessibilityLabel: exceptionLabel })
    const label = exception.findByProps({ children: 'Except default branch' })
    const parent = renderer.root.findByProps({ children: 'Hide sleeping' })

    expect(exception.props.style).toBe(styles.filterChildRow)
    expect(label.props.style).toBe(styles.filterChildRowText)
    expect(parent.props.style).toBe(styles.filterRowText)
    expect(styles.filterChildRow.paddingLeft).toBe(spacing.md + 2 + spacing.lg)
    expect(styles.filterRow.paddingHorizontal).toBe(spacing.md + 2)
    expect(styles.filterChildRowText.color).toBe(colors.textMuted)
    expect(styles.filterRowText.color).toBe(colors.textPrimary)
    renderer.unmount()
  })

  it('exposes whether the exception is on to a screen reader', () => {
    const enabled = renderFilters(true, true)
    const enabledRow = enabled.root.findByProps({ accessibilityLabel: exceptionLabel })
    expect(enabledRow.props.accessibilityRole).toBe('checkbox')
    expect(enabledRow.props.accessibilityState).toEqual({ checked: true })
    enabled.unmount()

    const disabled = renderFilters(true, false)
    const disabledRow = disabled.root.findByProps({ accessibilityLabel: exceptionLabel })
    expect(disabledRow.props.accessibilityState).toEqual({ checked: false })
    disabled.unmount()
  })

  it('stays hidden until Hide sleeping is on', () => {
    const renderer = renderFilters(false)

    expect(renderer.root.findAllByProps({ accessibilityLabel: exceptionLabel })).toHaveLength(0)
    renderer.unmount()
  })
})
