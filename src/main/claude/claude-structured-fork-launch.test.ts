import { describe, expect, it } from 'vitest'
import { applyClaudeStructuredForkLaunch } from './claude-structured-fork-launch'
import {
  claudeSessionIdForOrcaSession,
  type ClaudeStructuredLaunch
} from './claude-structured-launch-resolution'
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const launch: ClaudeStructuredLaunch = {
  pathToClaudeCodeExecutable: 'claude',
  options: { resume: 'parent', model: 'model' },
  cwd: '/workspace',
  claudeConfigDir: '/account',
  providerSessionId: 'parent',
  resumeLeafUuid: 'latest',
  resumed: true
}

describe('Claude structured fork launch', () => {
  it('combines forkSession with the selected UUID and a distinct child session identity', () => {
    const forked = applyClaudeStructuredForkLaunch(
      launch,
      {
        source: { provider: 'claude', sessionId: 'parent', leafUuid: 'latest' },
        throughId: 'selected'
      },
      'claude_new_session'
    )
    expect(forked.options).toMatchObject({
      forkSession: true,
      resume: 'parent',
      resumeSessionAt: 'selected',
      sessionId: forked.providerSessionId,
      model: 'model'
    })
    expect(forked.providerSessionId).not.toBe('parent')
    expect(forked.resumeLeafUuid).toBe('selected')
    expect(forked.resumed).toBe(false)
    expect(launch.options).not.toHaveProperty('forkSession')
  })

  it('refuses a source different from the account-pinned launch', () => {
    expect(() =>
      applyClaudeStructuredForkLaunch(
        launch,
        {
          source: { provider: 'claude', sessionId: 'foreign', leafUuid: null },
          throughId: 'selected'
        },
        'claude_new_session'
      )
    ).toThrow('agent_session_identity_required')
  })

  it('classifies BOTH refusals as pre-spawn, so a failed fork settles instead of stranding', () => {
    // Nothing here spawns: it rewrites launch arguments and its one caller runs it before the child
    // is opened. Unclassified, these two throws leave the child record at `attempted` forever —
    // every later attach throws `agent_session_operation_unknown` and the turn becomes permanently
    // unforkable, while the user is told to "retry the same turn", which that path cannot honour.
    const collides = claudeSessionIdForOrcaSession('claude_new_session')
    const cases: [ClaudeStructuredLaunch, string, string][] = [
      [launch, 'foreign', 'agent_session_identity_required'],
      [{ ...launch, resumed: false }, collides, 'agent_session_provider_handle_invalid']
    ]
    for (const [input, sessionId, message] of cases) {
      let thrown: unknown
      try {
        applyClaudeStructuredForkLaunch(
          input,
          { source: { provider: 'claude', sessionId, leafUuid: null }, throughId: 'selected' },
          'claude_new_session'
        )
      } catch (error) {
        thrown = error
      }
      expect((thrown as Error).message).toBe(message)
      expect(isAgentSessionPreSpawnError(thrown)).toBe(true)
    }
  })
})
