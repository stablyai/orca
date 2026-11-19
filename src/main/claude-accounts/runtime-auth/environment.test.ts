import { expect, it } from 'vitest'
import { CLAUDE_PROFILE_POINTER_ENV } from '../../../shared/agent-accounts/claude/claude-profile-routing'
import { applyClaudeEnvPatch } from './environment'

it('clears only the inherited Claude profile pointer when the workspace pins its own home', () => {
  const env = {
    [CLAUDE_PROFILE_POINTER_ENV]: 'host-pointer',
    CLAUDE_CONFIG_DIR: '/host/.claude'
  }

  applyClaudeEnvPatch(env, {
    [CLAUDE_PROFILE_POINTER_ENV]: '',
    CLAUDE_CONFIG_DIR: ''
  })

  expect(env[CLAUDE_PROFILE_POINTER_ENV]).toBe('')
  expect(env.CLAUDE_CONFIG_DIR).toBe('/host/.claude')
})
