import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { ClaudeResumeOrigin } from '../../../shared/claude-resume-origin'
import { AgentHookServer } from '../server'

const owner: ClaudeResumeOrigin = {
  installationId: 'installation',
  machineBinding: 'machine',
  host: { kind: 'local' }
}
const config = { kind: 'explicit', userHome: '/home/user', value: '/accounts/one' } as const

class ClaudeOriginProbe extends AgentHookServer {
  admit(event: AgentHookEventPayload, sameExecution = true) {
    this.cliWriterExecutionMatches = () => sameExecution
    return this.applyNormalizedStatus(event)
  }
}

function event(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab-origin:55555555-5555-4555-8555-555555555555',
    worktreeId: 'workspace',
    connectionId: null,
    launchToken: 'launch',
    source: 'claude',
    hookEventName: 'UserPromptSubmit',
    providerSession: { key: 'session_id', id: 'session', claudeConfig: config },
    payload: { agentType: 'claude', state: 'working', prompt: 'continue' },
    ...overrides
  }
}

describe('Claude hook server origin admission', () => {
  it('publishes and retains the admitted origin but clears it on an execution replacement', () => {
    const server = new ClaudeOriginProbe()
    server.setClaudeResumeOriginResolver(() => owner)
    expect(server.admit(event())?.providerSession?.claudeConfigOrigin).toEqual(owner)
    const heartbeat = event({
      hookEventName: 'PostToolUse',
      providerSession: { key: 'session_id', id: 'session' }
    })
    expect(server.admit(heartbeat)?.providerSession?.claudeConfig).toEqual(config)
    expect(server.getStatusSnapshot()[0]?.providerSession?.claudeConfigOrigin).toEqual(owner)
    expect(server.admit(heartbeat, false)?.providerSession?.claudeConfig).toBeUndefined()
  })

  it('keeps a recoverable session identity when the actual host cannot establish origin', () => {
    const server = new ClaudeOriginProbe()
    const admitted = server.admit(
      event({
        providerSession: {
          key: 'session_id',
          id: 'session',
          transcriptPath: '/accounts/one/projects/project/file.jsonl',
          claudeConfig: config,
          claudeConfigOrigin: owner
        }
      })
    )
    expect(admitted?.providerSession).toEqual({
      key: 'session_id',
      id: 'session',
      transcriptPath: '/accounts/one/projects/project/file.jsonl'
    })
  })

  it('admits only a captured context retained by the actual host', () => {
    const server = new ClaudeOriginProbe()
    server.setClaudeResumeOriginResolver(() => owner)
    const session = {
      key: 'session_id' as const,
      id: 'session',
      transcriptPath: '/accounts/one/projects/project/file.jsonl',
      claudeConfig: config,
      claudeConfigOrigin: owner
    }
    expect(server.getAdmittedClaudeResumeConfig(session, owner)).toBeUndefined()
    server.admit(event({ providerSession: session }))
    expect(server.getAdmittedClaudeResumeConfig(session, owner)).toEqual(config)
    for (const changed of [
      { ...session, id: 'other-session' },
      { ...session, transcriptPath: '/accounts/one/projects/project/other.jsonl' },
      { ...session, claudeConfig: { ...config, value: '/arbitrary/external/.claude' } }
    ]) {
      expect(server.getAdmittedClaudeResumeConfig(changed, owner)).toBeUndefined()
    }
    expect(
      server.getAdmittedClaudeResumeConfig(session, { ...owner, machineBinding: 'other' })
    ).toBeUndefined()
    server.admit(event({ providerSession: { key: 'session_id', id: 'session' } }), false)
    expect(server.getAdmittedClaudeResumeConfig(session, owner)).toBeUndefined()
  })
})
