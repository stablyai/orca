import { describe, expect, it } from 'vitest'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'

describe('OrcaRuntimeRpcServer', () => {
  it('classifies worker-start as a keepalive-backed long poll', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'req_worker_start',
        authToken: 'token',
        method: 'orchestration.workerStart',
        params: { task: 'task_1', timeoutMs: 60_000 }
      })
    ).toBe('wait')
  })

  it.each(['agent.launch', 'agent.launchReplay'])(
    'keeps a prompted %s alive while it waits for the agent to be ready',
    (method) => {
      const prompt = { text: 'fix the build', delivery: 'submit' }
      expect(
        classifyRuntimeLongPoll({
          id: 'req_launch',
          authToken: 'token',
          method,
          params: { prompt }
        })
      ).toBe('wait')
      // An existing workspace without a prompt remains a short call.
      expect(
        classifyRuntimeLongPoll({ id: 'req_launch', authToken: 'token', method, params: {} })
      ).toBeNull()
    }
  )

  it.each(['agent.launch', 'agent.launchReplay'])(
    'keeps unprompted %s workspace setup alive',
    (method) => {
      expect(
        classifyRuntimeLongPoll({
          id: 'req_setup',
          authToken: 'token',
          method,
          params: {
            target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
          }
        })
      ).toBe('wait')
      expect(
        classifyRuntimeLongPoll({
          id: 'req_existing',
          authToken: 'token',
          method,
          params: { target: { kind: 'existing', worktree: 'id:wt-7' } }
        })
      ).toBeNull()
    }
  )

  it('keeps agent-prompt submission sockets alive during verification', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'req_prompt',
        authToken: 'token',
        method: 'terminal.send',
        params: { agentPrompt: true }
      })
    ).toBe('wait')
    expect(
      classifyRuntimeLongPoll({
        id: 'req_direct',
        authToken: 'token',
        method: 'terminal.send',
        params: { agentPrompt: false }
      })
    ).toBeNull()
  })
})
