import { expect, it } from 'vitest'
import { withClaudeFlaggedRequestTerminalEnv } from './claude-flagged-request-env'

const stop = { claudeFlaggedRequestAction: 'stop' as const }

it('starts a Claude terminal without the fallback switch when Stop is chosen', () => {
  expect(withClaudeFlaggedRequestTerminalEnv({ TERM: 'xterm' }, true, stop, 'linux')).toEqual({
    TERM: 'xterm',
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1'
  })
  expect(withClaudeFlaggedRequestTerminalEnv(undefined, true, {}, 'linux')).toBeUndefined()
  expect(withClaudeFlaggedRequestTerminalEnv({ TERM: 'xterm' }, false, stop, 'linux')).toEqual({
    TERM: 'xterm'
  })
})

it('carries the switch into WSL on Windows', () => {
  const env = withClaudeFlaggedRequestTerminalEnv(
    { WSLENV: 'CLAUDE_CONFIG_DIR' },
    true,
    stop,
    'win32'
  )
  expect(env?.WSLENV).toBe('CLAUDE_CONFIG_DIR:CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK')
})
