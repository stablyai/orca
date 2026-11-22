import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { ClaudeStructuredSessionAdapter } from '../claude-structured-session-adapter'
import type { ClaudeLateDispatchOutcome } from '../claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from '../claude-structured-session-test-support'
import { claudeStartupSettled } from '../startup/claude-structured-startup-settled-test-support'

it.each(['exact', 'explicit', 'content'])(
  'keeps remints joined and preserves the next %s cycle boundary',
  async (correlation) => {
    const turns = new Map<string, string>()
    const settlements: ClaudeLateDispatchOutcome[] = []
    const claude = fakeClaude({ replayUuid: null })
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        pathToClaudeCodeExecutable: 'claude',
        options: {},
        cwd: '/work/repo',
        claudeConfigDir: '/accounts/claude',
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumesTranscript: false,
        cliFlag: async () => 'supported',
        continuesChain: false
      }),
      openConnection: claude.openConnection,
      readProcessStartTime: async () => 1,
      now: () => 1_700_000_200_000,
      persistHandle: async () => {},
      onDispatchSettledLate: (settlement) => settlements.push(settlement)
    })
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: {
        appendItem: (_identity, body) => {
          const turn = readAgentJournalTurn(body)
          if (turn) {
            turns.set(turn.turnId, turn.state)
          }
        },
        appendTombstone: () => {},
        publish: () => {}
      }
    })
    await claudeStartupSettled(adapter, 'session-1')
    const connection = claude.connections[0]!
    const frame = (message: Record<string, unknown>): void =>
      connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
    const send = async (clientMessageId: string, text: string): Promise<void> => {
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        fence: 7
      })
    }
    const echo = (uuid: string, text: string, userMessageUuid?: unknown): void =>
      frame({
        type: 'user',
        uuid,
        parent_tool_use_id: null,
        ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
        message: { role: 'user', content: [{ type: 'text', text }] }
      })

    await send('client-a', 'First distinct prompt')
    await send('client-b', 'Follow up while working')
    echo('remint-a', 'First distinct prompt')
    frame({
      type: 'assistant',
      uuid: 'continuing-a',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Still working' }] }
    })
    echo('remint-b', 'Follow up while working')
    expect([...turns]).toEqual([['remint-a', 'running']])
    expect(settlements).toMatchObject([
      { clientMessageId: 'client-a', providerIdentity: { uuid: 'remint-a' } },
      { clientMessageId: 'client-b', providerIdentity: { uuid: 'remint-b' } }
    ])

    frame({ type: 'result', subtype: 'success', uuid: 'result-ab', num_turns: 1 })
    await send('client-c', 'After completion')
    echo('remint-c', 'After completion')
    expect([...turns]).toEqual([
      ['remint-a', 'completed'],
      ['remint-c', 'running']
    ])

    frame({ type: 'system', subtype: 'init', uuid: 'next-cycle' })
    await send('client-d', 'Next provider cycle after a lost result')
    frame({
      type: 'assistant',
      uuid: 'd-output',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'New reply' }] }
    })
    const sentD = connection.sent.at(-1)!.uuid
    echo(
      correlation === 'exact' ? String(sentD) : 'remint-d',
      'Next provider cycle after a lost result',
      correlation === 'explicit' ? sentD : undefined
    )
    expect([...turns.values()]).toEqual(['completed', 'interrupted', 'running'])

    frame({ type: 'result', subtype: 'success', uuid: 'result-d', num_turns: 1 })
    await send('client-e', 'A send whose output precedes its echo')
    frame({
      type: 'command_lifecycle',
      state: 'started',
      command_uuid: connection.sent.at(-1)!.uuid
    })
    frame({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'pre-echo-e' })
    frame({ type: 'system', subtype: 'init', uuid: 'echo-e-cycle' })
    echo('remint-e', 'A send whose output precedes its echo')
    expect([...turns].at(-1)).toEqual(['pre-echo-e', 'running'])

    await send('client-f', 'Steer the current reply')
    frame({
      type: 'result',
      subtype: 'success',
      uuid: 'interrupted-step',
      terminal_reason: 'aborted_streaming',
      num_turns: 1
    })
    frame({ type: 'system', subtype: 'init', uuid: 'steer-cycle' })
    await send('client-g', 'Join the steered reply')
    echo('remint-f', 'Steer the current reply')
    frame({
      type: 'assistant',
      uuid: 'steered-output',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing the reply' }] }
    })
    echo('remint-g', 'Join the steered reply')
    expect([...turns.values()]).toEqual(['completed', 'interrupted', 'completed', 'running'])
    expect([...turns].at(-1)).toEqual(['pre-echo-e', 'running'])
  }
)
