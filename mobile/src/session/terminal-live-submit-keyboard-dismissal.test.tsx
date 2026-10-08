import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLiveInputCommitHarness } from '../terminal/terminal-live-input-commit.test-support'
import type { TerminalLiveHardwareKeyEvent } from '../terminal/terminal-live-hardware-key-mapping'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

const native = vi.hoisted(() => ({ dismiss: vi.fn() }))
vi.mock('react-native', () => ({ Keyboard: { dismiss: native.dismiss } }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn() }))
vi.mock('../platform/live-input-composing-range', () => ({
  reportedLiveInputComposing: (composing: boolean | undefined) => composing
}))

const unmounts: Array<() => void> = []

function mountLiveSend(agent = true) {
  let finishSubmit: (accepted: boolean) => void = () => {}
  const pendingSubmit = new Promise<boolean>((resolve) => {
    finishSubmit = resolve
  })
  const live = createTerminalLiveInputCommitHarness({
    sender: async (_handle, bytes) => (bytes === '\r' ? pendingSubmit : true)
  })
  let generation = 0
  const scope = {
    activeSessionTab: {
      type: 'terminal',
      title: 'Terminal',
      launchAgent: agent ? 'claude' : null
    },
    liveInputRef: { current: null },
    commandInputRef: { current: null },
    liveInputFocusTimerRef: { current: null },
    sendLiveTerminalInputRef: { current: async () => false },
    getSendCompletionGeneration: () => generation,
    getLiveInteractionGeneration: live.handlers.getLiveInputInteractionGeneration,
    handleLiveInputSubmit: live.handlers.handleLiveInputSubmit
  }
  let actions: ReturnType<typeof useMobileSessionTerminalSendActions> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only live submission is invoked; its fields and dismissal refs are provided above, while unrelated send paths are never called.
    actions = useMobileSessionTerminalSendActions(
      scope as unknown as MobileSessionTerminalWebviewModel
    )
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
  if (!actions || !renderer) {
    throw new Error('live send actions did not mount')
  }
  unmounts.push(() => {
    act(() => renderer?.unmount())
    live.unmount()
  })
  return {
    live,
    submit: () => {
      if (!actions) {
        throw new Error('live send actions are not mounted')
      }
      actions.submitLiveInput()
    },
    invalidateSurface: () => {
      generation += 1
    },
    finish: async (accepted: boolean) => {
      await act(async () => finishSubmit(accepted))
    }
  }
}

afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount())
  vi.clearAllMocks()
})

describe('live terminal submission keyboard dismissal', () => {
  it('dismisses an agent keyboard only after its Return is accepted', async () => {
    const send = mountLiveSend()
    send.submit()
    await vi.waitFor(() => expect(send.live.sent).toEqual(['\r']))
    expect(native.dismiss).not.toHaveBeenCalled()

    await send.finish(true)
    expect(native.dismiss).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps a plain shell keyboard after accepted=%s', async (accepted) => {
    const send = mountLiveSend(false)
    send.submit()
    await send.finish(accepted)
    expect(native.dismiss).not.toHaveBeenCalled()
  })

  it('keeps the agent keyboard when Return is rejected', async () => {
    const send = mountLiveSend()
    send.submit()
    await send.finish(false)
    expect(native.dismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss a replacement input surface after an old send completes', async () => {
    const send = mountLiveSend()
    send.submit()
    send.invalidateSurface()
    await send.finish(true)
    expect(native.dismiss).not.toHaveBeenCalled()
  })

  it.each(['ArrowLeft', 'Backspace'])(
    'keeps the keyboard if hardware %s follows a pending agent Return',
    async (key) => {
      const send = mountLiveSend()
      send.submit()
      await vi.waitFor(() => expect(send.live.sent).toEqual(['\r']))
      send.live.handlers.handleLiveInputHardwareKey({
        key,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        repeat: false
      })

      await send.finish(true)
      expect(native.dismiss).not.toHaveBeenCalled()
    }
  )

  it('does not treat a system-owned hardware shortcut as terminal interaction', async () => {
    const send = mountLiveSend()
    send.submit()
    const event: TerminalLiveHardwareKeyEvent = {
      key: 'c',
      modifiers: { ctrl: false, alt: false, shift: false, meta: true },
      repeat: false
    }
    send.live.handlers.handleLiveInputHardwareKey(event)

    await send.finish(true)
    expect(native.dismiss).toHaveBeenCalledOnce()
  })
})
