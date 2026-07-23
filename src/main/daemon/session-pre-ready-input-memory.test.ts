import { describe, expect, it } from 'vitest'
import { PRE_READY_STDIN_MAX_SEGMENTS, Session, type SubprocessHandle } from './session'

function createSubprocess(): SubprocessHandle {
  return {
    pid: 12345,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

describe('Session pre-ready input memory', () => {
  it('bounds one-character segments independently of the byte cap', () => {
    const session = new Session({
      sessionId: 'pre-ready-segment-test',
      cols: 80,
      rows: 24,
      subprocess: createSubprocess(),
      shellReadySupported: true
    })

    try {
      for (let index = 0; index < PRE_READY_STDIN_MAX_SEGMENTS; index += 1) {
        session.write('x')
      }
      expect(() => session.write('x')).toThrow('safe memory limit')
    } finally {
      session.dispose()
    }
  })
})
