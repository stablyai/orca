import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'
import {
  _resetDaemonTerminalViewAttributesForTest,
  setDaemonTerminalViewAttributes
} from './daemon-view-attributes'

function createSession(launchAgent?: TuiAgent) {
  let onData: ((data: string) => void) | null = null
  const written: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session reads only these members.
  const handle = {
    pid: 999,
    getForegroundProcess: () => null,
    confirmShellForeground: vi.fn(async () => false),
    write: (data: string) => written.push(data),
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    terminateOwnedTree: () => 'unavailable' as const,
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit() {},
    dispose: () => {}
  } as unknown as SubprocessHandle
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the omitted options are optional.
  const session = new Session({
    sessionId: 'responder',
    cols: 80,
    rows: 24,
    subprocess: handle,
    shellReadySupported: false,
    ...(launchAgent ? { launchAgent } : {})
  } as never)
  const attach = () => session.attachClient({ onData: () => {}, onExit: () => {} })
  attach()
  return { session, written, attach, emit: (data: string) => onData?.(data) }
}

function viewAttributes(): TerminalViewAttributes {
  return {
    foreground: [200, 200, 200],
    background: [10, 10, 10],
    cursor: [255, 255, 255],
    ansi: Array.from({ length: 256 }, (_, i): TerminalViewRgb => [i, 0, 0]),
    colorSchemeMode: 'dark',
    cursorStyle: 'block',
    cursorBlink: false
  }
}

afterEach(() => {
  _resetDaemonTerminalViewAttributesForTest()
})

describe('Session query responder delegation', () => {
  it('answers queries only while main delegated them', () => {
    const { session, written, emit } = createSession()
    emit('abc\x1b[6n')
    expect(written).toEqual([])

    session.setQueryResponder({})
    emit('\x1b[6n')
    expect(written).toEqual(['\x1b[1;4R'])

    session.setQueryResponder(null)
    emit('\x1b[6n')
    expect(written).toEqual(['\x1b[1;4R'])
    session.dispose()
  })

  it('drops a delegation when a client attaches, so the new main answers until it delegates', () => {
    const { session, written, attach, emit } = createSession()
    session.setQueryResponder({})
    attach()
    emit('\x1b[6n')
    expect(written).toEqual([])
    session.dispose()
  })

  it('applies the launch agent reply policy', () => {
    const { session, written, emit } = createSession('grok')
    session.setQueryResponder({})
    emit('\x1b[>0q\x1b[c')
    expect(written.some((reply) => reply.startsWith('\x1bP>|'))).toBe(false)
    expect(written.some((reply) => reply.startsWith('\x1b[?'))).toBe(true)
    session.dispose()
  })

  it('answers palette queries from the viewer attributes main pushed', () => {
    const { session, written, emit } = createSession()
    setDaemonTerminalViewAttributes(viewAttributes())
    session.setQueryResponder({})
    emit('\x1b]4;7;?\x07')
    expect(written).toEqual(['\x1b]4;7;rgb:0707/0000/0000\x1b\\'])
    session.dispose()
  })
})
