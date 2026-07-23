import { describe, expect, it } from 'vitest'
import { stripInheritedClaudeSessionEnv } from './claude-session-env'

describe('stripInheritedClaudeSessionEnv', () => {
  it('drops all Claude Code session markers while keeping every other inherited variable', () => {
    const env = {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'session-123',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      PATH: '/usr/bin',
      HOME: '/home/tester'
    }

    expect(stripInheritedClaudeSessionEnv(env)).toEqual({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      PATH: '/usr/bin',
      HOME: '/home/tester'
    })
  })

  it('does not mutate the source env', () => {
    const env = { CLAUDECODE: '1' }

    stripInheritedClaudeSessionEnv(env)

    expect(env.CLAUDECODE).toBe('1')
  })

  it('is a no-op when no marker keys are set', () => {
    expect(stripInheritedClaudeSessionEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})
