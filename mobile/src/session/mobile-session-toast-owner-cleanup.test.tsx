import { createElement, StrictMode } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

type AnimationStart = {
  options: { toValue: number; duration: number; useNativeDriver: boolean }
  complete: (result: { finished: boolean }) => void
}
const boundary = vi.hoisted(() => {
  const animationStarts: AnimationStart[] = []
  return {
    animationStarts,
    writeText: vi.fn<(text: string) => Promise<void>>(),
    success: vi.fn(),
    error: vi.fn(),
    synchronous: false
  }
})
vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios' },
  Keyboard: { dismiss: vi.fn() },
  Animated: {
    timing: (
      _value: unknown,
      options: { toValue: number; duration: number; useNativeDriver: boolean }
    ) => ({
      start: (complete: (result: { finished: boolean }) => void) => {
        boundary.animationStarts.push({ options, complete })
        if (boundary.synchronous) {
          complete({ finished: true })
        }
      }
    })
  }
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: boundary.writeText }),
  useClipboardReader: () => ({ contents: async () => ({ text: false, image: false }) })
}))
vi.mock('../platform/haptics', () => ({
  triggerSuccess: boundary.success,
  triggerError: boundary.error,
  triggerSelection: vi.fn(),
  triggerEdgeBump: vi.fn()
}))
vi.mock('../terminal/terminal-copy-gutter-preference', () => ({
  useTerminalCopyTrimsGutter: () => ({ current: false })
}))
vi.mock('./mobile-session-styles', () => ({ styles: { container: {}, kavInner: {} } }))
vi.mock('./MobileSessionHeader', () => ({ MobileSessionHeader: () => null }))
vi.mock('./MobileSessionContentRow', () => ({ MobileSessionContentRow: () => null }))
vi.mock('./MobileSessionSheets', () => ({ MobileSessionSheets: () => null }))
import { useMobileSessionFeedbackCapabilities } from './use-mobile-session-feedback-capabilities'
import { useMobileSessionAccessorySelection } from './use-mobile-session-accessory-selection'
import { MobileSessionSurface } from './MobileSessionSurface'

type FeedbackScope = Parameters<typeof useMobileSessionFeedbackCapabilities>[0]
type AccessoryScope = Parameters<typeof useMobileSessionAccessorySelection>[0]
type SurfaceController = Parameters<typeof MobileSessionSurface>[0]['controller']

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
  boundary.animationStarts.length = 0
  boundary.synchronous = false
  vi.restoreAllMocks()
})
function mounted(strict = false) {
  const setToastMessage = vi.fn()
  const clearTerminalCache = vi.fn()
  const cancelSelect = vi.fn()
  const scope = {
    client: null,
    connState: 'connected',
    initialCreateWarning: '',
    sessionTabs: [],
    sessionTabsRef: { current: [] },
    activeSessionTabId: null,
    activeSessionTabIdRef: { current: null },
    markdownDocs: new Map(),
    markdownDocsRef: { current: new Map() },
    createWarningState: { source: '', visible: '' },
    setCreateWarningState: vi.fn(),
    setToastMessage,
    toastOpacityRef: { current: {} },
    toastHideTimerRef: { current: null },
    toastSeqRef: { current: 0 },
    clientRef: { current: null },
    connStateRef: { current: 'connected' },
    activeSessionTabTypeRef: { current: 'terminal' },
    delayedActionTimersRef: { current: new Set() },
    activeSessionTab: { type: 'terminal' },
    worktreeId: 'folder:remote',
    isFloatingWorkspaceRoute: false,
    setTerminalKeyboardMetrics: vi.fn(),
    setSelectModeActive: vi.fn(),
    setCanPaste: vi.fn(),
    ptyModesRef: { current: new Map() },
    initialModesSeenRef: { current: new Set() },
    terminalRefs: { current: new Map([['handle', { cancelSelect }]]) },
    liveInputFocusTimerRef: { current: null },
    sessionTabActionSheetRequestSeqRef: { current: 0 },
    activeHandleRef: { current: 'handle' },
    clearPendingLiveInputCommit: vi.fn(),
    clearTerminalCache,
    handleAccessoryKey: vi.fn(),
    clearSessionTabActionSheetKeyboardListener: vi.fn()
  }
  const read: {
    value:
      | (ReturnType<typeof useMobileSessionAccessorySelection> &
          ReturnType<typeof useMobileSessionFeedbackCapabilities>)
      | undefined
  } = { value: undefined }
  function Probe({
    surfaceKey = 'initial',
    visible = true
  }: {
    surfaceKey?: string
    visible?: boolean
  }) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Actual feedback hook reads only the enumerated members; its type includes unrelated composed controller hooks.
    const feedbackScope = scope as unknown as FeedbackScope
    const feedback = useMobileSessionFeedbackCapabilities(feedbackScope)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Actual accessory hook reads only enumerated members plus actual feedback capability callbacks.
    const accessoryScope = { ...scope, ...feedback } as unknown as AccessoryScope
    const accessory = useMobileSessionAccessorySelection(accessoryScope)
    const result = { ...feedback, ...accessory }
    read.value = result
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Actual surface reads only setMobileSessionRootRef; its child components are isolated presentation stubs.
    const controller = result as unknown as SurfaceController
    return visible ? createElement(MobileSessionSurface, { key: surfaceKey, controller }) : null
  }
  let root: ReturnType<typeof create> | undefined
  const element = (surfaceKey = 'initial', visible = true) =>
    strict
      ? createElement(StrictMode, null, createElement(Probe, { surfaceKey, visible }))
      : createElement(Probe, { surfaceKey, visible })
  act(() => {
    root = create(element(), { createNodeMock: () => ({}) })
  })
  if (!root || !read.value) {
    throw new Error('real composed hooks did not mount')
  }
  const renderer = root
  return {
    root,
    get api() {
      if (!read.value) {
        throw new Error('real composed hooks did not render')
      }
      return read.value
    },
    scope,
    setToastMessage,
    clearTerminalCache,
    cancelSelect,
    rerender: (surfaceKey: string, visible = true) =>
      act(() => renderer.update(element(surfaceKey, visible)))
  }
}
it.each([
  ['success', false],
  ['failure', false],
  ['success', true],
  ['failure', true]
] as const)(
  'keeps admitted %s copy outcome after unmount without new timers, StrictMode=%s',
  async (outcome, strict) => {
    vi.useFakeTimers()
    let resolveWrite: (() => void) | undefined
    let rejectWrite: ((error: Error) => void) | undefined
    const clipboard = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve
      rejectWrite = reject
    })
    boundary.writeText.mockReturnValue(clipboard)
    const view = mounted(strict)
    const baselineClear = view.clearTerminalCache.mock.calls.length
    const baselineSequence = view.scope.toastSeqRef.current
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let copying: Promise<void> | undefined
    act(() => {
      copying = view.api.handleSelectionCopy('handle', 'original text')
    })
    expect(boundary.writeText.mock.calls).toEqual([['original text']])
    expect(boundary.animationStarts).toHaveLength(0)
    act(() => view.root.unmount())
    expect(view.clearTerminalCache).toHaveBeenCalledTimes(baselineClear + 1)
    expect(view.scope.toastSeqRef.current).toBe(baselineSequence + 1)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      if (outcome === 'success') {
        resolveWrite?.()
      } else {
        rejectWrite?.(new Error('clipboard refused'))
      }
      await copying
    })
    expect(boundary.success).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
    expect(boundary.error).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0)
    expect(view.cancelSelect).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
    expect(warn.mock.calls).toEqual(
      outcome === 'failure'
        ? [['[mobile-clip] setString failed', { name: 'Error', message: 'clipboard refused' }]]
        : []
    )
    for (const animation of boundary.animationStarts) {
      act(() => animation.complete({ finished: true }))
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(boundary.animationStarts).toHaveLength(0)
    expect(view.setToastMessage).not.toHaveBeenCalled()
  }
)
it('proves existing detach sequence already fences an admitted fade-in', () => {
  vi.useFakeTimers()
  const view = mounted()
  act(() => view.api.showToast('already visible'))
  expect(boundary.animationStarts).toHaveLength(1)
  act(() => view.root.unmount())
  act(() => boundary.animationStarts[0].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(0)
  expect(boundary.animationStarts).toHaveLength(1)
})
it('proves existing detach cleanup clears a live hide timer', () => {
  vi.useFakeTimers()
  const view = mounted()
  act(() => view.api.showToast('already visible'))
  act(() => boundary.animationStarts[0].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(1)
  act(() => view.root.unmount())
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])(
  'preserves late admitted copy after same-hook root replacement, StrictMode=%s',
  async (strict) => {
    vi.useFakeTimers()
    let finish: (() => void) | undefined
    boundary.writeText.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const view = mounted(strict)
    const originalShow = view.api.showToast
    let copying: Promise<void> | undefined
    act(() => {
      copying = view.api.handleSelectionCopy('handle', 'original text')
    })
    const previousClear = view.clearTerminalCache.mock.calls.length
    view.rerender('replacement')
    expect(view.clearTerminalCache.mock.calls.length).toBeGreaterThan(previousClear)
    expect(view.api.showToast).toBe(originalShow)
    await act(async () => {
      finish?.()
      await copying
    })
    expect(boundary.writeText.mock.calls).toEqual([['original text']])
    expect(boundary.success).toHaveBeenCalledTimes(1)
    expect(view.cancelSelect).toHaveBeenCalledTimes(1)
    expect(view.setToastMessage.mock.calls).toEqual([['Copied']])
    expect(boundary.animationStarts).toHaveLength(1)
    act(() => boundary.animationStarts[0].complete({ finished: true }))
    expect(vi.getTimerCount()).toBe(1)
    act(() => view.root.unmount())
    expect(vi.getTimerCount()).toBe(0)
  }
)
it('preserves late copy while surface is temporarily detached but hook stays mounted', async () => {
  vi.useFakeTimers()
  let finish: (() => void) | undefined
  boundary.writeText.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const view = mounted()
  let copying: Promise<void> | undefined
  act(() => {
    copying = view.api.handleSelectionCopy('handle', 'original text')
  })
  view.rerender('inactive', false)
  expect(view.clearTerminalCache).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish?.()
    await copying
  })
  expect(boundary.success).toHaveBeenCalledTimes(1)
  expect(view.cancelSelect).toHaveBeenCalledTimes(1)
  expect(view.setToastMessage.mock.calls).toEqual([['Copied']])
  act(() => boundary.animationStarts[0].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(1)
  view.rerender('active', true)
  act(() => view.root.unmount())
  expect(vi.getTimerCount()).toBe(0)
})
it.each([1200, 1500])('keeps exact live fade-in/hide/fade-out timing at %s ms', (duration) => {
  vi.useFakeTimers()
  const view = mounted()
  act(() => view.api.showToast('message', duration))
  expect(view.setToastMessage.mock.calls).toEqual([['message']])
  expect(boundary.animationStarts[0].options).toEqual({
    toValue: 1,
    duration: 150,
    useNativeDriver: true
  })
  act(() => boundary.animationStarts[0].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(1)
  act(() => {
    vi.advanceTimersByTime(duration - 1)
  })
  expect(boundary.animationStarts).toHaveLength(1)
  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(vi.getTimerCount()).toBe(0)
  expect(boundary.animationStarts[1].options).toEqual({
    toValue: 0,
    duration: 200,
    useNativeDriver: true
  })
  act(() => boundary.animationStarts[1].complete({ finished: true }))
  expect(view.setToastMessage.mock.calls).toEqual([['message'], [null]])
  act(() => view.root.unmount())
})
it('preserves old unfinished/replaced animation fences and latest toast ownership', () => {
  vi.useFakeTimers()
  const view = mounted()
  act(() => view.api.showToast('first'))
  act(() => view.api.showToast('second', 1500))
  act(() => boundary.animationStarts[0].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(0)
  act(() => boundary.animationStarts[1].complete({ finished: false }))
  expect(vi.getTimerCount()).toBe(0)
  act(() => view.api.showToast('third'))
  act(() => boundary.animationStarts[2].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(1)
  act(() => view.api.showToast('fourth'))
  expect(vi.getTimerCount()).toBe(0)
  act(() => boundary.animationStarts[3].complete({ finished: true }))
  act(() => {
    vi.advanceTimersByTime(1200)
  })
  act(() => view.api.showToast('fifth'))
  act(() => boundary.animationStarts[4].complete({ finished: true }))
  expect(view.setToastMessage.mock.calls).toEqual([
    ['first'],
    ['second'],
    ['third'],
    ['fourth'],
    ['fifth']
  ])
  act(() => view.root.unmount())
})
it('keeps 64 admitted copies after 64 surface/hook unmounts without new timers', async () => {
  vi.useFakeTimers()
  const releases: (() => void)[] = []
  const copying: Promise<void>[] = []
  const views: ReturnType<typeof mounted>[] = []
  for (let index = 0; index < 64; index++) {
    boundary.writeText.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releases.push(resolve)
      })
    )
    const view = mounted()
    views.push(view)
    act(() => {
      copying.push(view.api.handleSelectionCopy('handle', 'copy' + index))
    })
    act(() => view.root.unmount())
  }
  expect(boundary.writeText.mock.calls).toEqual(
    Array.from({ length: 64 }, (_, index) => ['copy' + index])
  )
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    for (const release of releases) {
      release()
    }
    await Promise.all(copying)
  })
  expect(boundary.success).toHaveBeenCalledTimes(64)
  expect(boundary.error).not.toHaveBeenCalled()
  for (const view of views) {
    expect(view.cancelSelect).toHaveBeenCalledTimes(1)
    expect(view.clearTerminalCache).toHaveBeenCalledTimes(1)
  }
  for (const animation of boundary.animationStarts) {
    act(() => animation.complete({ finished: true }))
  }
  expect(vi.getTimerCount()).toBe(0)
  expect(boundary.animationStarts).toHaveLength(0)
})

it('preserves synchronous native completion and natural hide cleanup', () => {
  vi.useFakeTimers()
  boundary.synchronous = true
  const view = mounted()
  act(() => view.api.showToast('sync'))
  expect(vi.getTimerCount()).toBe(1)
  act(() => {
    vi.advanceTimersByTime(1200)
  })
  expect(vi.getTimerCount()).toBe(0)
  expect(view.setToastMessage.mock.calls).toEqual([['sync'], [null]])
  expect(boundary.animationStarts.map((start) => start.options)).toEqual([
    { toValue: 1, duration: 150, useNativeDriver: true },
    { toValue: 0, duration: 200, useNativeDriver: true }
  ])
  act(() => view.root.unmount())
})
it('preserves reentrant newer-toast sequence and animation start order', () => {
  vi.useFakeTimers()
  const view = mounted()
  view.setToastMessage.mockImplementationOnce(() => view.api.showToast('inner'))
  act(() => view.api.showToast('outer'))
  expect(view.setToastMessage.mock.calls).toEqual([['outer'], ['inner']])
  expect(boundary.animationStarts).toHaveLength(2)
  act(() => boundary.animationStarts[0].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(1)
  act(() => boundary.animationStarts[1].complete({ finished: true }))
  expect(vi.getTimerCount()).toBe(1)
  act(() => {
    vi.advanceTimersByTime(1200)
  })
  act(() => boundary.animationStarts[2].complete({ finished: true }))
  expect(view.setToastMessage.mock.calls).toEqual([['outer'], ['inner'], [null]])
  act(() => view.root.unmount())
})
