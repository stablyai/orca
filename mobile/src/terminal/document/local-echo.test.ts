import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { forgetLocalEcho, predictLocalEcho, reconcileLocalEcho, resetLocalEcho } from './local-echo'

// Claude Code's prompt row: "❯ " then the typed text, real cursor right after it (checked in tmux, 2026-10-27).
function createEchoScope() {
  const screen = { text: '❯ ', cursorX: 2, type: 'normal' }
  const scope = createTerminalDocumentScope({ root: { querySelector: () => null } as never })
  const base = terminalDocumentDouble().terminal
  scope.term = {
    ...base,
    buffer: {
      active: {
        length: 1,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        get cursorX() {
          return screen.cursorX
        },
        get type() {
          return screen.type
        },
        getLine: () => ({
          length: base.cols,
          isWrapped: false,
          translateToString: (_trim: boolean, start = 0, end = base.cols) =>
            screen.text.padEnd(base.cols).slice(start, end)
        })
      }
    }
  }
  const hostEcho = (text: string) => {
    screen.text += text
    screen.cursorX += text.length
    reconcileLocalEcho(scope)
  }
  return { scope, screen, hostEcho }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('local echo', () => {
  it('shows typed text at the cursor until the host echoes it', () => {
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'hel')
    expect(scope.localEchoPending).toEqual(['h', 'e', 'l'])
    expect(scope.localEchoAnchor).toEqual({ col: 2, row: 0 })

    hostEcho('he')
    expect(scope.localEchoPending).toEqual(['l'])
    expect(scope.localEchoAnchor).toEqual({ col: 4, row: 0 })

    hostEcho('l')
    expect(scope.localEchoPending).toEqual([])
    expect(scope.localEchoAnchor).toBeNull()
  })

  it('does not confirm a repeated letter before its own echo arrives', () => {
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'he')
    hostEcho('he')
    predictLocalEcho(scope, 'l')
    reconcileLocalEcho(scope)
    expect(scope.localEchoPending).toEqual(['l'])
  })

  it('takes back unconfirmed guesses on backspace', () => {
    const { scope } = createEchoScope()
    predictLocalEcho(scope, 'ab\x7f')
    expect(scope.localEchoPending).toEqual(['a'])
  })

  it('drops all guesses on control bytes or backspace into echoed text', () => {
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'ab\r')
    expect(scope.localEchoPending).toEqual([])

    predictLocalEcho(scope, 'x')
    hostEcho('x')
    predictLocalEcho(scope, '\x7fy')
    expect(scope.localEchoPending).toEqual([])
  })

  it('predicts in the alternate screen, where Claude Code runs under Orca', () => {
    const { scope, screen, hostEcho } = createEchoScope()
    screen.type = 'alternate'
    predictLocalEcho(scope, 'hi')
    expect(scope.localEchoPending).toEqual(['h', 'i'])
    hostEcho('h')
    expect(scope.localEchoTrustedRow).toBe(0)
  })

  it('trusts a row only after the host echoes a guess there', () => {
    vi.useFakeTimers()
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'a')
    expect(scope.localEchoTrustedRow).toBeNull()
    hostEcho('a')
    expect(scope.localEchoTrustedRow).toBe(0)

    // A sudo-style prompt that stops echoing loses trust after the first miss.
    predictLocalEcho(scope, 's')
    vi.advanceTimersByTime(1500)
    expect(scope.localEchoTrustedRow).toBeNull()
  })

  it('drops trust on Enter so a prompt on the same row starts untrusted', () => {
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'a')
    hostEcho('a')
    predictLocalEcho(scope, '\r')
    expect(scope.localEchoTrustedRow).toBeNull()
  })

  it('forgets row trust when the host switches screen buffers', () => {
    const { scope, screen, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'a')
    hostEcho('a')
    expect(scope.localEchoTrustedRow).toBe(0)
    screen.type = 'alternate'
    reconcileLocalEcho(scope)
    expect(scope.localEchoTrustedRow).toBeNull()
  })

  it('expires by the oldest guess even while typing continues', () => {
    vi.useFakeTimers()
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'a')
    hostEcho('a')
    // Echo stops on a trusted row; steady typing must not keep the first guess alive.
    predictLocalEcho(scope, 'b')
    vi.advanceTimersByTime(1000)
    predictLocalEcho(scope, 'c')
    vi.advanceTimersByTime(500)
    expect(scope.localEchoPending).toEqual([])
    expect(scope.localEchoTrustedRow).toBeNull()
  })

  it('forgets row trust when the terminal content is replaced', () => {
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'a')
    hostEcho('a')
    expect(scope.localEchoTrustedRow).toBe(0)
    forgetLocalEcho(scope)
    expect(scope.localEchoTrustedRow).toBeNull()
  })

  it('keeps a mismatched guess hidden and expires it', () => {
    vi.useFakeTimers()
    const { scope, hostEcho } = createEchoScope()
    predictLocalEcho(scope, 'a')
    hostEcho('A')
    expect(scope.localEchoPending).toEqual(['a'])
    vi.advanceTimersByTime(1500)
    expect(scope.localEchoPending).toEqual([])
    resetLocalEcho(scope)
  })
})
