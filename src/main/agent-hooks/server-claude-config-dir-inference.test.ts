import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-config-dir', '11111111-1111-4111-8111-111111111111')
const CONFIG_DIR = '/home/dev/.claude-grok'

function baselineRequest(server: AgentHookServer) {
  const [entry] = server.getStatusSnapshot()
  return {
    paneKey: entry.paneKey,
    baselineUpdatedAt: entry.receivedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    baselinePrompt: entry.prompt as string,
    baselineAgentType: entry.agentType
  }
}

describe('Claude config-dir status inference', () => {
  it('preserves configDir when inferring an interrupted turn', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        payload: {
          state: 'working',
          prompt: 'flavored task',
          agentType: 'claude',
          configDir: CONFIG_DIR
        }
      },
      'connection-1'
    )

    expect(
      server.inferInterrupt({
        ...baselineRequest(server),
        intent: 'ctrl-c'
      })
    ).toBe(true)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      interrupted: true,
      configDir: CONFIG_DIR
    })
  })

  it('preserves configDir when inferring an answered question', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        hookEventName: 'PreToolUse',
        toolUseId: 'tool-question',
        payload: {
          state: 'waiting',
          agentType: 'claude',
          toolName: 'AskUserQuestion',
          configDir: CONFIG_DIR
        }
      },
      'connection-1'
    )

    expect(server.inferQuestionAnswered(baselineRequest(server))).toBe(true)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      configDir: CONFIG_DIR
    })
  })
})
