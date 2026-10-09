import { createElement, useState, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSourceControlContent } from './MobileSourceControlContent'
import * as branchFormat from './mobile-branch-entry-format'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  SectionList: ({ ListFooterComponent }: { ListFooterComponent: ReactElement }) =>
    createElement('SectionList', null, ListFooterComponent),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ArrowDownUp: 'ArrowDownUp',
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronRight: 'ChevronRight',
  CloudUpload: 'CloudUpload',
  FileText: 'FileText',
  GitBranch: 'GitBranch',
  GitPullRequestArrow: 'GitPullRequestArrow',
  History: 'History',
  Minus: 'Minus',
  MoreHorizontal: 'MoreHorizontal',
  Plus: 'Plus',
  RefreshCw: 'RefreshCw',
  Sparkles: 'Sparkles',
  Trash2: 'Trash2'
}))

const noop = () => {}
const unusedAsync = async (): Promise<never> => {
  throw new Error('unused action')
}

function initialState(): MobileSourceControlState {
  const branchEntries = Array.from({ length: 20 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    status: 'modified' as const,
    added: 3,
    removed: 1,
    canOpen: true
  }))
  const branchCompareResult = {
    entries: branchEntries,
    summary: {
      status: 'ready' as const,
      baseRef: 'main',
      changedFiles: 20,
      commitsAhead: undefined,
      errorMessage: undefined
    }
  }
  return {
    client: null,
    connState: 'connected',
    forceReconnect: null,
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    router: {
      back: noop,
      push: noop,
      replace: noop,
      navigate: noop,
      dismiss: noop,
      dismissAll: noop,
      dismissTo: noop,
      prefetch: noop,
      canGoBack: () => false,
      canDismiss: () => false,
      setParams: noop,
      reload: noop
    },
    setRootRef: noop,
    worktreeLabel: 'fixture',
    screenState: { kind: 'loading' },
    branchCompareState: { kind: 'ready', result: branchCompareResult },
    branchDiffPreview: null,
    setBranchDiffPreview: noop,
    busyAction: null,
    commitMessage: '',
    setCommitMessage: noop,
    generatingMessage: false,
    showBranchPicker: false,
    setShowBranchPicker: noop,
    localBranches: null,
    createdPrUrl: null,
    setCreatedPrUrl: noop,
    createdPrWarning: null,
    setCreatedPrWarning: noop,
    discardTarget: null,
    setDiscardTarget: noop,
    showActionSheet: false,
    setShowActionSheet: noop,
    actionError: null,
    commitFailureRecovery: null,
    commitFailureRecoveryAction: {
      summary: null,
      hasDetails: false,
      launching: false,
      availability: 'available',
      launchError: null,
      launchWarning: null,
      launchSuccess: null,
      undeliveredPrompt: null,
      launch: unusedAsync
    },
    keyboardLift: 0,
    openingPath: null,
    openingBranchPath: null,
    status: null,
    sections: [],
    branchCompareResult,
    branchCompareSummaryText: '20 files vs main',
    branchEntries,
    shouldShowBranchCompareSection: true,
    hasVisibleChanges: true,
    stageablePaths: [],
    unstageablePaths: [],
    stagedCount: 1,
    unstagedCount: 0,
    branchLabel: 'fixture',
    upstream: undefined,
    upstreamKnown: false,
    syncLabel: null,
    primaryAction: {
      kind: 'commit',
      label: 'Commit',
      accessibilityLabel: 'Commit',
      accessibilityHint: '',
      disabled: false,
      loading: false,
      onPress: noop
    },
    createPrAction: {
      visible: false,
      label: 'Create Pull Request',
      disabled: true,
      loading: false,
      pushFirst: false,
      onPress: noop
    },
    loadStatus: unusedAsync,
    openFile: unusedAsync,
    openBranchDiff: unusedAsync,
    runGitAction: unusedAsync,
    stageAll: unusedAsync,
    unstageAll: unusedAsync,
    commit: unusedAsync,
    generateCommitMessage: unusedAsync,
    cancelGenerateCommitMessage: noop,
    createPr: unusedAsync,
    openBranchPicker: noop,
    openHistory: noop,
    checkoutBranch: unusedAsync,
    abortConflictOperation: unusedAsync,
    runActionSheetCommit: unusedAsync,
    runActionSheetCommitSequence: unusedAsync,
    runActionSheetCommitSync: unusedAsync,
    runActionSheetGitSequence: unusedAsync,
    runActionSheetGitSync: unusedAsync,
    runActionSheetRebase: unusedAsync
  }
}

let renderer: ReactTestRenderer | null = null
const controls: { patch: ((patch: Partial<MobileSourceControlState>) => void) | null } = {
  patch: null
}

function Fixture({ initial }: { initial: MobileSourceControlState }) {
  const [state, setState] = useState(initial)
  controls.patch = (patch) => setState((previous) => ({ ...previous, ...patch }))
  return createElement(MobileSourceControlContent, {
    state: {
      ...state,
      setCommitMessage: (next) =>
        setState((previous) => ({
          ...previous,
          commitMessage: typeof next === 'function' ? next(previous.commitMessage) : next
        }))
    }
  })
}

function render(initial = initialState()) {
  act(() => {
    renderer = create(createElement(Fixture, { initial }))
  })
}
function patch(values: Partial<MobileSourceControlState>) {
  act(() => {
    controls.patch?.(values)
  })
}
function rows() {
  return (
    renderer?.root.findAll(
      (node) =>
        String(node.type) === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Open committed change')
    ) ?? []
  )
}
function text() {
  return JSON.stringify(renderer?.toJSON())
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  controls.patch = null
  vi.restoreAllMocks()
})

describe('committed branch files during commit-message typing', () => {
  it.each(['scroll', 'sections'])('keeps the footer without revisiting rows in %s', (layout) => {
    const initial = initialState()
    if (layout === 'sections') {
      initial.sections = [{ area: 'staged', title: 'Staged Changes', data: [] }]
    }
    const format = vi.spyOn(branchFormat, 'formatMobileBranchEntryMeta')
    render(initial)
    expect(format).toHaveBeenCalledTimes(20)
    format.mockClear()
    for (let index = 0; index < 50; index++) {
      act(() => {
        const input = renderer?.root.find((node) => String(node.type) === 'TextInput')
        if (typeof input?.props.onChangeText !== 'function') {
          throw new Error('missing input handler')
        }
        input.props.onChangeText(`message ${index}`)
      })
    }
    expect(renderer?.root.find((node) => String(node.type) === 'TextInput').props.value).toBe(
      'message 49'
    )
    expect(rows()).toHaveLength(20)
    expect(format).not.toHaveBeenCalled()
  })

  it('updates the footer when each of its inputs changes independently', () => {
    const initial = initialState()
    const format = vi.spyOn(branchFormat, 'formatMobileBranchEntryMeta')
    render(initial)
    patch({ branchCompareSummaryText: 'changed summary' })
    expect(text()).toContain('changed summary')
    const first = initial.branchEntries[0]
    if (!first) {
      throw new Error('missing fixture entry')
    }
    patch({ branchEntries: [{ ...first, path: 'changed.ts' }] })
    expect(rows()).toHaveLength(1)
    expect(text()).toContain('changed.ts')
    patch({ busyAction: 'stage-all' })
    expect(rows()[0]?.props.disabled).toBe(true)
    patch({ busyAction: null })
    expect(rows()[0]?.props.disabled).toBe(false)
    patch({ openingPath: 'local.ts' })
    expect(rows()[0]?.props.disabled).toBe(true)
    patch({ openingPath: null })
    patch({ openingBranchPath: 'changed.ts' })
    expect(rows()[0]?.props.disabled).toBe(true)
    expect(rows()[0]?.findAll((node) => String(node.type) === 'ActivityIndicator')).toHaveLength(1)
    patch({ openingBranchPath: null })
    const open = vi.fn(async () => {})
    patch({ openBranchDiff: open })
    act(() => {
      const onPress = rows()[0]?.props.onPress
      if (typeof onPress !== 'function') {
        throw new Error('missing branch opener')
      }
      onPress()
    })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'changed.ts' }))
    patch({ branchCompareState: { kind: 'error', message: 'compare failed' } })
    expect(text()).toContain('compare failed')
    expect(rows()).toHaveLength(0)
    patch({ branchCompareState: initial.branchCompareState })
    patch({
      branchCompareResult: {
        ...initial.branchCompareResult,
        summary: {
          status: 'error',
          baseRef: 'main',
          changedFiles: 0,
          commitsAhead: undefined,
          errorMessage: 'unavailable'
        }
      }
    })
    expect(text()).toContain('unavailable')
    expect(rows()).toHaveLength(0)
    patch({ branchCompareResult: initial.branchCompareResult })
    expect(rows()).toHaveLength(1)
    patch({ shouldShowBranchCompareSection: false })
    expect(text()).not.toContain('Committed on Branch')
    patch({ shouldShowBranchCompareSection: true })
    expect(rows()).toHaveLength(1)
    format.mockClear()
    patch({ connState: 'disconnected', actionError: 'offline', keyboardLift: 100 })
    expect(text()).toContain('Reconnecting to desktop')
    expect(text()).toContain('offline')
    expect(format).not.toHaveBeenCalled()
  })
})
