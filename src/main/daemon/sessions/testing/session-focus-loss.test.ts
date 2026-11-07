import { describe, expect, it, vi } from 'vitest'
import { Session } from '../session'
import type { SubprocessHandle } from '../session-subprocess-handle'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

function createSession() {
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session reads only the options given here.
  const session = new Session({
    sessionId: 'focus',
    cols: 80,
    rows: 24,
    subprocess: handle,
    shellReadySupported: false
  } as never)
  const emit = async (data: string): Promise<void> => {
    onData?.(data)
    await session.settleShellOwnershipConfirmation()
  }
  const attach = () => session.attachClient({ onData: () => {}, onExit: () => {} })
  return { session, written, emit, attach }
}

describe('Session focus loss', () => {
  it('tells a ?1004 program focus is gone when its last viewer detaches, once', async () => {
    const { session, written, emit, attach } = createSession()
    const first = attach()
    const second = attach()
    await emit('\x1b[?1004h')
    session.write(FOCUS_IN)

    session.detachClient(first)
    expect(written).toEqual([FOCUS_IN])

    session.detachClient(second)
    session.reportFocusLost()
    expect(written).toEqual([FOCUS_IN, FOCUS_OUT])
    session.dispose()
  })

  it('does not repeat a blur the viewer already sent', async () => {
    const { session, written, emit, attach } = createSession()
    const token = attach()
    await emit('\x1b[?1004h')
    session.write(FOCUS_OUT)

    session.detachClient(token)

    expect(written).toEqual([FOCUS_OUT])
    session.dispose()
  })

  it('tells a newly armed program even after its predecessor heard the blur', async () => {
    const { session, written, emit, attach } = createSession()
    const token = attach()
    await emit('\x1b[?1004h')
    session.write(FOCUS_OUT)
    await emit('\x1b[?1004l\x1b[?1004h')

    session.detachClient(token)

    expect(written).toEqual([FOCUS_OUT, FOCUS_OUT])
    session.dispose()
  })
})
