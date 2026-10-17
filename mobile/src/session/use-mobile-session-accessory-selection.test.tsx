// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileSessionTerminalInputModel } from './use-mobile-session-terminal-input'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' }
}))

vi.mock('../platform/haptics', () => ({
  triggerSelection: vi.fn(),
  triggerSuccess: vi.fn(),
  triggerError: vi.fn(),
  triggerEdgeBump: vi.fn()
}))

vi.mock('./mobile-session-read-operations', () => ({
  newTabRepoListRead: { request: vi.fn(), interpret: vi.fn(() => []) }
}))

vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: vi.fn(async () => {}) }),
  useClipboardReader: () => ({ contents: vi.fn(async () => ({ text: false, image: false })) })
}))

vi.mock('../terminal/terminal-copy-gutter-preference', () => ({
  useTerminalCopyTrimsGutter: () => ({ current: false })
}))

import {
  useMobileSessionAccessorySelection,
  type MobileSessionAccessorySelectionModel
} from './use-mobile-session-accessory-selection'

describe('useMobileSessionAccessorySelection repeatable key hold and scroll cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function setup() {
    const handleAccessoryKey = vi.fn(async () => {})
    let latest: ReturnType<typeof useMobileSessionAccessorySelection> | null = null

    function Harness() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test harness stubbing only the fields reached by repeat handlers.
      const scope = {
        worktreeId: 'wt-1',
        isFloatingWorkspaceRoute: false,
        client: null,
        connState: 'connected',
        setTerminalKeyboardMetrics: vi.fn(),
        setSelectModeActive: vi.fn(),
        setCanPaste: vi.fn(),
        toastSeqRef: { current: 0 },
        ptyModesRef: { current: new Map() },
        initialModesSeenRef: { current: new Set() },
        terminalRefs: { current: new Map() },
        liveInputFocusTimerRef: { current: null },
        sessionTabActionSheetRequestSeqRef: { current: 0 },
        activeHandleRef: { current: 'term-1' },
        clearPendingLiveInputCommit: vi.fn(),
        clearDelayedActionTimers: vi.fn(),
        clearToastHideTimer: vi.fn(),
        showToast: vi.fn(),
        clearTerminalCache: vi.fn(),
        handleAccessoryKey,
        clearSessionTabActionSheetKeyboardListener: vi.fn()
      } as unknown as MobileSessionTerminalInputModel

      latest = useMobileSessionAccessorySelection(scope)
      return null
    }

    await act(async () => {
      create(createElement(Harness))
    })

    const getApi = (): MobileSessionAccessorySelectionModel => {
      if (!latest) {
        throw new Error('Harness did not mount')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test helper returning the mounted hook output.
      return latest as unknown as MobileSessionAccessorySelectionModel
    }

    return { handleAccessoryKey, getApi }
  }

  it('emits zero key presses when a touch on a repeatable arrow key becomes a horizontal scroll before 400ms', async () => {
    const { handleAccessoryKey, getApi } = await setup()
    const upInput = { bytes: '\u001b[A' }

    // Finger touches ↑ (onPressIn), then ScrollView begins dragging at 120ms (onScrollBeginDrag + onPressOut).
    getApi().startAccessoryRepeat(upInput)
    expect(handleAccessoryKey).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120)
    getApi().stopAccessoryRepeat()

    await vi.advanceTimersByTimeAsync(600)
    expect(handleAccessoryKey).not.toHaveBeenCalled()
    expect(getApi().consumeAccessoryRepeatHandled()).toBe(false)
  })

  it('leaves consumeAccessoryRepeatHandled false on a short tap so onPress sends the key once', async () => {
    const { handleAccessoryKey, getApi } = await setup()
    const upInput = { bytes: '\u001b[A' }

    getApi().startAccessoryRepeat(upInput)
    await vi.advanceTimersByTimeAsync(90)
    getApi().stopAccessoryRepeat()

    expect(handleAccessoryKey).not.toHaveBeenCalled()
    expect(getApi().consumeAccessoryRepeatHandled()).toBe(false)
  })

  it('repeats after 400ms hold and marks repeat handled so release does not double-send', async () => {
    const { handleAccessoryKey, getApi } = await setup()
    const upInput = { bytes: '\u001b[A' }

    getApi().startAccessoryRepeat(upInput)
    await vi.advanceTimersByTimeAsync(399)
    expect(handleAccessoryKey).not.toHaveBeenCalled()

    // Initial hold fire at 400ms + two 45ms repeat ticks (400, 445, 490).
    await vi.advanceTimersByTimeAsync(91)
    expect(handleAccessoryKey).toHaveBeenCalledTimes(3)

    // User lifts finger: onPressOut calls stopAccessoryRepeat(), then onPress checks consumeAccessoryRepeatHandled().
    getApi().stopAccessoryRepeat()
    expect(getApi().consumeAccessoryRepeatHandled()).toBe(true)
    expect(getApi().consumeAccessoryRepeatHandled()).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(handleAccessoryKey).toHaveBeenCalledTimes(3)
  })
})
