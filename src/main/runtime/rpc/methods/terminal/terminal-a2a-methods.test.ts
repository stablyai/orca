import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_A2A_METHODS } from './terminal-a2a-methods'
import * as terminalA2aIpc from '../../../../ipc/terminal-a2a'

describe('TERMINAL_A2A_METHODS', () => {
  it('defines terminal.a2aLink and broadcasts link event', async () => {
    const broadcastSpy = vi.spyOn(terminalA2aIpc, 'broadcastA2ALink').mockImplementation(() => {})
    const method = TERMINAL_A2A_METHODS.find((m) => m.name === 'terminal.a2aLink')
    expect(method).toBeDefined()

    type RpcMethodWithHandler = {
      handler: (
        params: unknown,
        ctx: unknown
      ) => Promise<{ ok: boolean; id: string; delivered?: boolean; targetHandle?: string }>
    }

    const handler = (method as unknown as RpcMethodWithHandler).handler
    const res = await handler(
      {
        from: '@2',
        to: '@5',
        fromIndex: 2,
        toIndex: 5,
        fromLabel: 'worker',
        toLabel: 'tester',
        type: 'send',
        text: 'npm test',
        timestamp: 123456789
      },
      {}
    )

    expect(res.ok).toBe(true)
    expect(res.id).toMatch(/^a2a-/)
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '@2',
        to: '@5',
        fromIndex: 2,
        toIndex: 5,
        type: 'send',
        text: 'npm test'
      })
    )

    broadcastSpy.mockRestore()
  })

  it('dispatches to real terminal PTY when runtime has matching target', async () => {
    type RpcMethodWithHandler = {
      handler: (
        params: unknown,
        ctx: unknown
      ) => Promise<{ ok: boolean; id: string; delivered?: boolean; targetHandle?: string }>
    }

    const broadcastSpy = vi.spyOn(terminalA2aIpc, 'broadcastA2ALink').mockImplementation(() => {})
    const method = TERMINAL_A2A_METHODS.find((m) => m.name === 'terminal.a2aLink')
    const handler = (method as unknown as RpcMethodWithHandler).handler

    const mockSendTerminal = vi.fn().mockResolvedValue({
      send: { accepted: true, bytesWritten: 12 }
    })
    const mockRuntime = {
      listTerminals: vi.fn().mockResolvedValue({
        terminals: [
          { handle: 'term-1', index: 1, title: 'agent-1' },
          { handle: 'term-2', index: 2, title: 'agent-2' }
        ]
      }),
      sendTerminal: mockSendTerminal
    }

    const res = await handler(
      {
        from: '@1',
        to: '@2',
        fromIndex: 1,
        toIndex: 2,
        type: 'send',
        text: 'echo "hello"',
        dispatch: true
      },
      { runtime: mockRuntime }
    )

    expect(res.ok).toBe(true)
    expect(res.delivered).toBe(true)
    expect(res.targetHandle).toBe('term-2')
    expect(mockSendTerminal).toHaveBeenCalledWith(
      'term-2',
      expect.objectContaining({
        text: 'echo "hello"',
        enter: true
      })
    )

    broadcastSpy.mockRestore()
  })
})
