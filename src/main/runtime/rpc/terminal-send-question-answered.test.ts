import './unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer, agentHookServer } from '../../agent-hooks/server'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { stubRuntime } from './terminal-multiplex-test-harness'

const PANE_KEY = makePaneKey('tab-question', '11111111-1111-4111-8111-111111111111')

afterEach(() => {
  vi.restoreAllMocks()
})

function claudeAsking(questions: unknown[]): AgentHookServer {
  const server = new AgentHookServer()
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: 'tab-question',
      worktreeId: 'worktree-question',
      hookEventName: 'PreToolUse',
      toolUseId: 'tool-question',
      payload: {
        state: 'waiting',
        agentType: 'claude',
        toolName: 'AskUserQuestion',
        interactivePrompt: JSON.stringify({ questions })
      }
    },
    'connection-1'
  )
  vi.spyOn(agentHookServer, 'getStatusSnapshotForPane').mockImplementation((paneKey) =>
    server.getStatusSnapshotForPane(paneKey)
  )
  vi.spyOn(agentHookServer, 'inferQuestionAnswered').mockImplementation((request) =>
    server.inferQuestionAnswered(request)
  )
  return server
}

async function phoneSends(text: string): Promise<void> {
  const runtime = stubRuntime({
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    getLiveTerminalPaneKey: () => PANE_KEY,
    sendTerminal: vi
      .fn()
      .mockResolvedValue({ handle: 'terminal-1', accepted: true, bytesWritten: 1 })
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const response = await dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.send',
    params: { terminal: 'terminal-1', text, client: { id: 'phone', type: 'mobile' } }
  })
  expect(response.ok).toBe(true)
}

const option = (label: string) => ({ label, description: '' })

it('clears the Claude question wait when a phone keystroke finishes the answer', async () => {
  const server = claudeAsking([{ question: 'Pick', options: [option('A'), option('B')] }])

  await phoneSends('2')

  expect(server.getStatusSnapshotForPane(PANE_KEY)[0]?.state).not.toBe('waiting')
})
