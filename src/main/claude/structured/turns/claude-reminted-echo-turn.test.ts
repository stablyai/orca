import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { ClaudeStructuredSessionAdapter } from '../claude-structured-session-adapter'
import type { ClaudeLateDispatchOutcome } from '../claude-structured-session-state'
import { fakeClaude, identityFor, PROVIDER_SESSION_ID } from '../claude-structured-session-test-support'
import { claudeStartupSettled } from '../startup/claude-structured-startup-settled-test-support'

it('keeps correlated remints in one reply, then opens later cycles normally', async () => {
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
        if (turn) turns.set(turn.turnId, turn.state)
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
  const echo = (uuid: string, text: string): void =>
    frame({
      type: 'user',
      uuid,
      parent_tool_use_id: null,
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

  await send('client-d', 'Next provider cycle after a lost result')
  frame({ type: 'system', subtype: 'init', uuid: 'next-cycle' })
  echo('remint-d', 'Next provider cycle after a lost result')
  expect([...turns]).toEqual([
    ['remint-a', 'completed'],
    ['remint-c', 'interrupted'],
    ['remint-d', 'running']
  ])
})
