import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../session'

const NOTE = { launchToken: 'launch-1', launchConfig: { agentArgs: '--verbose', agentEnv: {} } }

let session: Session | null = null
let emit: (data: string) => void = () => {}

afterEach(() => {
  session?.dispose()
  session = null
})

function createSession(): Session {
  session = new Session({
    sessionId: 'launch-note-session',
    cols: 80,
    rows: 24,
    shellReadySupported: false,
    subprocess: {
      pid: 1,
      getForegroundProcess: () => null,
      write() {},
      resize() {},
      kill() {},
      terminateOwnedTree: () => 'unavailable' as const,
      forceKill() {},
      signal() {},
      onData(cb: (data: string) => void) {
        emit = cb
      },
      onExit() {},
      dispose() {}
    }
  })
  return session
}

// The launch can finish while main is down, so the daemon must retire the note without main.
describe('a daemon session launch note', () => {
  it('retires when the launched command finishes', () => {
    const s = createSession()
    s.setLaunchNote(NOTE)
    emit('agent output\r\n')
    expect(s.launchNote).toEqual(NOTE)
    emit('\x1b]133;D;143\x07')
    expect(s.launchNote).toBeNull()
  })
})
