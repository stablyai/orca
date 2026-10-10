import { describe, expect, it } from 'vitest'
import { withoutHostTerminalEnv } from './real-shell-test-env'

describe('withoutHostTerminalEnv', () => {
  it('drops the launching terminal identity and keeps everything else', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'Apple_Terminal',
      TERM_PROGRAM_VERSION: '455',
      TERM_SESSION_ID: 'session',
      SHELL_SESSION_HISTORY: '1'
    }

    expect(withoutHostTerminalEnv(env)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      TERM: 'xterm-256color'
    })
    expect(env.TERM_PROGRAM).toBe('Apple_Terminal')
  })
})
