import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'

vi.mock('../terminal/mobile-terminal-operations', () => ({
  terminalInputSend: {},
  terminalBufferClear: {}
}))
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))

const renderers: ReactTestRenderer[] = []

function mountToggle(liveInputEnabled: boolean, keyboardHeight: number) {
  const liveInput = {
    focus: vi.fn(),
    blur: vi.fn(),
    isFocused: () => liveInputEnabled && keyboardHeight === 0
  }
  const commandInput = {
    focus: vi.fn(),
    blur: vi.fn(),
    isFocused: () => !liveInputEnabled && keyboardHeight === 0
  }
  const scope = {
    activeHandle: 'terminal-a',
    keyboardHeight,
    toggleTerminalLiveInput: () => !liveInputEnabled,
    clearPendingLiveInputCommit: vi.fn(),
    liveInputRef: { current: liveInput },
    commandInputRef: { current: commandInput },
    liveInputFocusTimerRef: { current: null }
  }
  let toggle = (): void => {}
  function Harness(): null {
    const actions = useMobileSessionTerminalInput(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only toggleLiveInput runs; all fields it reads are supplied above.
      scope as unknown as Parameters<typeof useMobileSessionTerminalInput>[0]
    )
    toggle = actions.toggleLiveInput
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  return { toggle, liveInput, commandInput }
}

afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Live input keyboard handoff', () => {
  it.each([
    [true, 0],
    [false, 0],
    [true, 280],
    [false, 280]
  ] as const)(
    'hands focus off synchronously with Live input %s and keyboard height %s',
    (liveInputEnabled, keyboardHeight) => {
      vi.useFakeTimers()
      const { toggle, liveInput, commandInput } = mountToggle(liveInputEnabled, keyboardHeight)

      act(toggle)

      expect(liveInputEnabled ? commandInput.focus : liveInput.focus).toHaveBeenCalledTimes(1)
      expect(liveInput.blur).not.toHaveBeenCalled()
      expect(commandInput.blur).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
