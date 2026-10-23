import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { ClaudeResumeOrigin } from '../../../shared/claude-resume-origin'
import { bindClaudeResumeContext } from './claude-resume-context'

const owner: ClaudeResumeOrigin = {
  installationId: 'installation',
  machineBinding: 'machine',
  host: { kind: 'local' }
}
const config = { kind: 'explicit', userHome: '/home/user', value: '/profiles/one/.claude' } as const

function row(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab:leaf',
    worktreeId: 'workspace',
    connectionId: null,
    launchToken: 'launch',
    source: 'claude',
    hookEventName: 'Stop',
    providerSession: { key: 'session_id', id: 'session', claudeConfig: config },
    payload: { agentType: 'claude', state: 'done', prompt: '' },
    ...overrides
  }
}

describe('admitted Claude resume context', () => {
  it('replaces a caller-claimed origin with the admitted PTY owner', () => {
    const incoming = row({
      providerSession: {
        key: 'session_id',
        id: 'session',
        claudeConfig: config,
        claudeConfigOrigin: { ...owner, installationId: 'claimed' }
      }
    })
    expect(
      bindClaudeResumeContext(incoming, undefined, owner, true, false).providerSession
    ).toEqual({
      key: 'session_id',
      id: 'session',
      claudeConfig: config,
      claudeConfigOrigin: owner
    })
    expect(
      bindClaudeResumeContext(incoming, undefined, undefined, true, false).providerSession
    ).toEqual({ key: 'session_id', id: 'session' })
  })

  it('preserves same-session context on a heartbeat that omits it', () => {
    const previous = bindClaudeResumeContext(
      row({
        providerSession: {
          key: 'session_id',
          id: 'session',
          transcriptPath: '/profiles/one/.claude/projects/work/file.jsonl',
          claudeConfig: config
        }
      }),
      undefined,
      owner,
      true,
      false
    )
    const heartbeat = row({ providerSession: { key: 'session_id', id: 'session' } })
    expect(
      bindClaudeResumeContext(heartbeat, previous, owner, true, false).providerSession
    ).toEqual(previous.providerSession)
    expect(
      bindClaudeResumeContext(row({ providerSession: undefined }), previous, owner, true, false)
        .providerSession
    ).toEqual(previous.providerSession)
  })

  it('does not carry credentials across process, session, launch or execution-owner replacement', () => {
    const previous = bindClaudeResumeContext(
      row({
        agentPresence: {
          agent: 'claude',
          process: { pid: 20, platform: 'linux', startTime: 'one' }
        }
      }),
      undefined,
      owner,
      true,
      false
    )
    for (const incoming of [
      row({ providerSession: { key: 'session_id', id: 'other-session' } }),
      row({ launchToken: 'other-launch', providerSession: { key: 'session_id', id: 'session' } }),
      row({
        agentPresence: {
          agent: 'claude',
          process: { pid: 20, platform: 'linux', startTime: 'two' }
        },
        providerSession: { key: 'session_id', id: 'session' }
      })
    ]) {
      expect(
        bindClaudeResumeContext(incoming, previous, owner, true, false).providerSession
          ?.claudeConfig
      ).toBeUndefined()
    }
    const heartbeat = row({ providerSession: { key: 'session_id', id: 'session' } })
    expect(
      bindClaudeResumeContext(heartbeat, previous, owner, false, false).providerSession
        ?.claudeConfig
    ).toBeUndefined()
    expect(
      bindClaudeResumeContext(heartbeat, previous, owner, true, true).providerSession?.claudeConfig
    ).toBeUndefined()
    expect(
      bindClaudeResumeContext(
        heartbeat,
        previous,
        { ...owner, machineBinding: 'other' },
        true,
        false
      ).providerSession?.claudeConfig
    ).toBeUndefined()
    expect(
      bindClaudeResumeContext(
        row({
          agentPresence: {
            agent: 'claude',
            process: { pid: 20, platform: 'linux', startTime: 'nested' }
          }
        }),
        previous,
        owner,
        true,
        false
      ).providerSession?.claudeConfig
    ).toBeUndefined()
  })

  it('does not let an old relay replay overwrite newer checked context', () => {
    const previous = bindClaudeResumeContext(row(), undefined, owner, true, false)
    const replay = row({
      isReplay: true,
      providerSession: {
        key: 'session_id',
        id: 'session',
        claudeConfig: { kind: 'default', userHome: '/home/user' },
        claudeConfigOrigin: owner
      }
    })
    expect(bindClaudeResumeContext(replay, previous, owner, true, false).providerSession).toEqual(
      previous.providerSession
    )
    expect(
      bindClaudeResumeContext(replay, undefined, owner, true, false).providerSession?.claudeConfig
    ).toEqual(replay.providerSession?.claudeConfig)
    expect(
      bindClaudeResumeContext(replay, undefined, undefined, true, false).providerSession
        ?.claudeConfig
    ).toBeUndefined()
    expect(
      bindClaudeResumeContext(row({ source: 'codex' }), undefined, owner, true, false)
        .providerSession?.claudeConfig
    ).toBeUndefined()
  })
})
