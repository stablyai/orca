import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function makeRequest(params: unknown): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.create',
    params
  }
}

function createDispatcher(): {
  dispatcher: RpcDispatcher
  createTerminal: ReturnType<typeof vi.fn>
} {
  const createTerminal = vi.fn().mockResolvedValue('terminal-1')
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    createTerminal
  } as unknown as OrcaRuntimeService

  return {
    dispatcher: new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }),
    createTerminal
  }
}

describe('terminal.create RPC', () => {
  it('forwards a literal-true Windows Codex shell handoff marker', async () => {
    const { dispatcher, createTerminal } = createDispatcher()
    const launchConfig = {
      agentCommand: 'codex',
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' },
      windowsCodexShellHandoff: true
    }

    const response = await dispatcher.dispatch(
      makeRequest({
        worktree: 'id:wt-1',
        launchConfig
      })
    )

    expect(response.ok).toBe(true)
    expect(createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ launchConfig })
    )
  })

  it.each([false, 'true', 1])(
    'fails closed for a malformed Windows Codex shell handoff marker (%j)',
    async (windowsCodexShellHandoff) => {
      const { dispatcher, createTerminal } = createDispatcher()

      const response = await dispatcher.dispatch(
        makeRequest({
          worktree: 'id:wt-1',
          launchConfig: {
            agentCommand: 'codex',
            agentArgs: '--model gpt-5',
            agentEnv: { CODEX_PROFILE: 'captured' },
            windowsCodexShellHandoff
          }
        })
      )

      expect(response.ok).toBe(true)
      expect(createTerminal).toHaveBeenCalledTimes(1)
      expect(createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('launchConfig')
    }
  )
})
