import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'test-token', method, params }
}

describe('OpenCode guarded terminal send', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses a marker title left on a shell without writing notes', async () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({
      write,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree',
          title: 'OC | zsh',
          activeLeafId: 'pane-1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree',
          leafId: 'pane-1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'OC | zsh'
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await expect(
      dispatcher.dispatch(request('terminal.agentStatus', { terminal: terminal.handle }))
    ).resolves.toMatchObject({
      ok: true,
      result: { agentStatus: { isRunningAgent: false, status: null } }
    })

    const send = dispatcher.dispatch(
      request('terminal.send', {
        terminal: terminal.handle,
        text: '$(touch should-not-run)',
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(send).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0, refusedReason: 'no-agent' } }
    })
    expect(write).not.toHaveBeenCalled()
  })
})
