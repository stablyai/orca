import { describe, expect, it } from 'vitest'
import { Session } from '../session'
import type { SubprocessHandle } from '../session-subprocess-handle'

function createUnattachedSession() {
  let onData: ((data: string) => void) | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session reads only these members.
  const handle = {
    pid: 999,
    getForegroundProcess: () => null,
    confirmShellForeground: async () => false,
    write: () => {},
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
    sessionId: 'pre-attach',
    cols: 80,
    rows: 24,
    subprocess: handle,
    shellReadySupported: false
  } as never)
  return { session, emit: (data: string) => onData?.(data) }
}

// ConPTY's startup preamble: emitted, and replayed into the session, before the creating client attaches.
const CONPTY_PREAMBLE = '\x1b[?9001h\x1b[?1004h\x1b[6n'

describe('Session output sequence before the first attach', () => {
  it('counts only bytes a stream client can receive, so it matches the count main keeps from attach', () => {
    const { session, emit } = createUnattachedSession()
    emit(CONPTY_PREAMBLE)
    expect(session.getSnapshot()!.outputSequence).toBe(0)

    const received: string[] = []
    const token = session.attachClient({
      onData: (data: string) => received.push(data),
      onExit: () => {}
    })
    emit('prompt> ')
    emit('\x1b[38;5;46mok\x1b[0m')

    // Pin what the client received, so a silently dropped delivery cannot make both sides 0.
    expect(received.join('')).toBe('prompt> \x1b[38;5;46mok\x1b[0m')
    expect(session.getSnapshot()!.outputSequence).toBe(received.join('').length)

    // A detached session keeps counting: the next attach reconciles against the snapshot's sequence.
    session.detachClient(token)
    emit('later')
    expect(session.getSnapshot()!.outputSequence).toBe(received.join('').length + 'later'.length)
    session.dispose()
  })
})
