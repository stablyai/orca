import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { CODEX_CAPACITY_MESSAGE } from '../../shared/codex-native-notice'

afterEach(() => _internals.resetCachesForTests())

describe('Codex capacity verdict in the shared status store', () => {
  it('keeps a local failure through Stop and child activity, then clears it on retry', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const post = (payload: Record<string, unknown>) =>
      postHookEvent(server, buildBody({ session_id: 'session-1', ...payload }), '/hook/codex')
    try {
      expect(
        (await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Say hi', model: 'gpt-5' })).ok
      ).toBe(true)
      const previous = server.getStatusSnapshotForPane(PANE)[0]
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: {
          state: 'done',
          agentType: 'codex',
          prompt: previous?.prompt ?? '',
          model: previous?.model,
          lastAssistantMessage: CODEX_CAPACITY_MESSAGE,
          mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: Date.now() }
        }
      })
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        prompt: 'Say hi',
        model: 'gpt-5',
        lastAssistantMessage: CODEX_CAPACITY_MESSAGE,
        providerSession: { id: 'session-1' },
        mainAgent: { state: 'done', outcome: 'failure' }
      })
      await post({ hook_event_name: 'Stop' })
      await post({ hook_event_name: 'SubagentStart', agent_id: 'child-1' })
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'failure' }
      })
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Say hi' })
      expect(server.getStatusSnapshotForPane(PANE)[0]?.mainAgent).toMatchObject({
        state: 'working'
      })
      expect(server.getStatusSnapshotForPane(PANE)[0]?.mainAgent?.outcome).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('accepts host capacity evidence after an earlier done and preserves it across relay restatements', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: {
          state: 'done',
          agentType: 'codex',
          prompt: 'Say hi',
          mainAgent: { state: 'done', stateStartedAt: 1 }
        }
      },
      'ssh-host'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'ssh-host',
      payload: {
        state: 'done',
        agentType: 'codex',
        prompt: 'Say hi',
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 2 }
      }
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'Stop',
        payload: {
          state: 'done',
          agentType: 'codex',
          prompt: 'Say hi'
        }
      },
      'ssh-host'
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]?.mainAgent?.outcome).toBe('failure')
  })
})
