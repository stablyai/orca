import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSourceControlContent } from './MobileSourceControlContent'
import { MobileSourceControlNextStepBar } from './MobileSourceControlNextStepBar'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

type MobileSourceControlContentState = Omit<MobileSourceControlState, 'primaryActionArgs'> & {
  primaryAction: MobileSourceControlPrimaryAction
}
import type { SectionListProps } from 'react-native'
import type {
  MobileBranchEntryView,
  MobileGitStatusEntryView
} from './mobile-source-control-screen-state'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  SectionList: (props: SectionListProps<MobileBranchEntryView | MobileGitStatusEntryView>) =>
    createElement(
      'SectionList',
      { ...props, ListHeaderComponent: undefined },
      typeof props.ListHeaderComponent === 'function' ? null : props.ListHeaderComponent,
      typeof props.ListFooterComponent === 'function'
        ? createElement(props.ListFooterComponent)
        : props.ListFooterComponent,
      props.sections.map((section) =>
        createElement(
          'Section',
          { key: section.key },
          props.renderSectionHeader?.({ section }),
          section.data.slice(0, 20).map((item, index) =>
            createElement(
              'Row',
              { key: item.path },
              props.renderItem?.({
                item,
                index,
                section,
                separators: { highlight: noop, unhighlight: noop, updateProps: noop }
              })
            )
          )
        )
      )
    ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }))
// Counts row renders: every file row draws its line stats once.
const rowRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../components/MobileDiffReviewFileSummary', () => ({
  MobileDiffLineStats: () => {
    rowRenders.count += 1
    return null
  }
}))
vi.mock('react-native-gesture-handler', async () => {
  const chain = new Proxy({}, { get: () => () => chain })
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: { children: unknown }) => children
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: unknown }) => children },
  Easing: { bezier: () => () => 0 },
  ReduceMotion: { Never: 'never' },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ArrowDownUp: 'ArrowDownUp',
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  CloudUpload: 'CloudUpload',
  FileText: 'FileText',
  GitBranch: 'GitBranch',
  GitCommitHorizontal: 'GitCommitHorizontal',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  GitPullRequestArrow: 'GitPullRequestArrow',
  History: 'History',
  Minus: 'Minus',
  MoreHorizontal: 'MoreHorizontal',
  Plus: 'Plus',
  RefreshCw: 'RefreshCw',
  Sparkles: 'Sparkles',
  Trash2: 'Trash2',
  TriangleAlert: 'TriangleAlert',
  Undo2: 'Undo2'
}))

const noop = () => {}
const unusedAsync = async (): Promise<never> => {
  throw new Error('unused action')
}

function initialState(): MobileSourceControlContentState {
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
    rebaseBaseRef: 'main',
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
    status: null,
    sections: [],
    branchCompareResult,
    branchEntries,
    shouldShowBranchCompareSection: true,
    hasVisibleChanges: true,
    stageablePaths: [],
    unstageablePaths: [],
    stagedCount: 1,
    unstagedCount: 0,
    branchLabel: 'fixture',
    upstreamKnown: false,
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
      reviewLabel: 'pull request',
      disabled: true,
      loading: false,
      pushFirst: false,
      onPress: noop
    },
    loadStatus: unusedAsync,
    openDiffForFile: noop,
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
    resolveConflict: unusedAsync,
    completeMerge: unusedAsync,
    runActionSheetCommit: unusedAsync,
    runActionSheetCommitSequence: unusedAsync,
    runActionSheetCommitSync: unusedAsync,
    runActionSheetGitSequence: unusedAsync,
    runActionSheetGitSync: unusedAsync,
    runActionSheetRebase: unusedAsync
  }
}

let renderer: ReactTestRenderer | null = null
const controls: { patch: ((patch: Partial<MobileSourceControlContentState>) => void) | null } = {
  patch: null
}

function Fixture({ initial }: { initial: MobileSourceControlContentState }) {
  const [state, setState] = useState(initial)
  controls.patch = (patch) => setState((previous) => ({ ...previous, ...patch }))
  const liveState = {
    ...state,
    setCommitMessage: (next: string | ((previous: string) => string)) =>
      setState((previous) => ({
        ...previous,
        commitMessage: typeof next === 'function' ? next(previous.commitMessage) : next
      }))
  }
  // Laid out as the panel does: the commit box lives in the bar beside the list.
  return createElement(
    'View',
    null,
    createElement(MobileSourceControlContent, {
      state: liveState,
      bottomInset: 0,
      onOpenCommits: noop
    }),
    createElement(MobileSourceControlNextStepBar, {
      view: { kind: 'composer' },
      notice: null,
      agentNotice: null,
      mergeConfirm: null,
      composer: liveState,
      primaryAction: state.primaryAction,
      keyboardLift: state.keyboardLift,
      bottomInset: 0,
      onHeightChange: noop
    })
  )
}

function render(initial = initialState()) {
  act(() => {
    renderer = create(createElement(Fixture, { initial }))
  })
}
function patch(values: Partial<MobileSourceControlContentState>) {
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
  // Section headers carry React elements in props; serialize only what renders.
  return JSON.stringify(renderer?.toJSON(), (key, value) =>
    key === 'sections' ? undefined : value
  )
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  controls.patch = null
  vi.restoreAllMocks()
})

describe('committed branch files during commit-message typing', () => {
  it.each(['clean', 'dirty'])('keeps the list without revisiting rows in %s', (layout) => {
    const initial = initialState()
    if (layout === 'dirty') {
      initial.sections = [{ id: 'staged', area: 'staged', title: 'Staged Changes', data: [] }]
    }
    rowRenders.count = 0
    render(initial)
    expect(rowRenders.count).toBe(20)
    rowRenders.count = 0
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
    expect(rowRenders.count).toBe(0)
  })

  it.each([false, true])(
    'passes all committed files through the list window (dirty: %s)',
    (dirty) => {
      const initial = initialState()
      const first = initial.branchEntries[0]
      if (!first) {
        throw new Error('missing branch fixture')
      }
      initial.branchEntries = Array.from({ length: 20_000 }, (_, index) => ({
        ...first,
        path: `file-${index}.ts`
      }))
      if (dirty) {
        initial.sections = [{ id: 'staged', area: 'staged', title: 'Staged Changes', data: [] }]
      }
      render(initial)
      expect(rows().length).toBeGreaterThan(0)
      expect(rows().length).toBeLessThanOrEqual(20)
      const list = renderer?.root.find((node) => String(node.type) === 'SectionList')
      expect(list?.props.sections.at(-1).data).toBe(initial.branchEntries)
    }
  )

  it('updates rows and section messages when their inputs change', () => {
    const initial = initialState()
    render(initial)
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
    const open = vi.fn()
    patch({ openDiffForFile: open })
    act(() => {
      const onPress = rows()[0]?.props.onPress
      if (typeof onPress !== 'function') {
        throw new Error('missing branch opener')
      }
      onPress()
    })
    expect(open).toHaveBeenCalledWith({ kind: 'changes', filePath: 'changed.ts', area: 'branch' })
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
    expect(text()).not.toContain('On this branch')
    patch({ shouldShowBranchCompareSection: true })
    expect(rows()).toHaveLength(1)
    patch({ connState: 'disconnected', actionError: 'offline' })
    expect(text()).toContain('Reconnecting to desktop')
    expect(text()).toContain('offline')
  })
})

describe('AI commit message button', () => {
  function generateButton() {
    return renderer?.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        (node.props.accessibilityLabel === 'Generate commit message with AI' ||
          node.props.accessibilityLabel === 'Cancel commit message generation')
    )
  }

  it('matches desktop: a typed message blocks regenerating, and cancel stays available', () => {
    render()
    expect(generateButton()?.props.disabled).toBe(false)
    patch({ commitMessage: 'my own message' })
    expect(generateButton()?.props.disabled).toBe(true)
    expect(generateButton()?.props.accessibilityHint).toBe('Clear the message to regenerate.')
    patch({ generatingMessage: true })
    expect(generateButton()?.props.disabled).toBe(false)
  })
})

describe('next-step bar and the keyboard', () => {
  function input() {
    return renderer?.root.findAll((node) => String(node.type) === 'TextInput')[0] ?? null
  }

  it('rides the keyboard for its own commit box and steps aside for any other field', () => {
    render()
    // Another field (a PR comment) raised the keyboard: the bar must not cover it.
    patch({ keyboardLift: 300 })
    expect(input()).toBeNull()
    patch({ keyboardLift: 0 })
    act(() => {
      const onFocus = input()?.props.onFocus
      if (typeof onFocus !== 'function') {
        throw new Error('missing focus handler')
      }
      onFocus()
    })
    patch({ keyboardLift: 300 })
    expect(input()).not.toBeNull()
  })
})
