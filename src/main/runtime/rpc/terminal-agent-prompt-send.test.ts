import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'request', authToken: 'token', method: 'terminal.send', params }
}

function makeRuntime(overrides: Partial<OrcaRuntimeService>): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

describe('terminal agent prompt send RPC', () => {
  it('routes an explicit CLI agent prompt through settled prompt delivery', async () => {
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 19
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'review this change',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('terminal-1', 'review this change', {
      assertWriteAuthority: expect.any(Function),
      beforeWrite: undefined,
      requireSettledForeground: true,
      signal: undefined
    })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('preserves direct input when the CLI target is not a proven settlement agent', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 7
    })
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: false,
      bytesWritten: 0
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'echo x',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      { text: 'echo x', enter: true, interrupt: false },
      { assertWriteAuthority: expect.any(Function), beforeWrite: undefined }
    )
    expect(sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('does not fall back after settled foreground authority is lost', async () => {
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi
      .fn()
      .mockRejectedValue(new Error('terminal_guard_not_writable'))
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'review this change',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('does not send delayed Enter after a paired mobile client takes the floor', async () => {
    const writes: string[] = []
    const ordering: string[] = []
    let floorOwner: 'desktop' | 'mobile' = 'desktop'
    let releaseSettlement!: () => void
    const settlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve
    })
    let pasteWritten!: () => void
    const paste = new Promise<void>((resolve) => {
      pasteWritten = resolve
    })
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi.fn(
      async (
        _handle: string,
        _prompt: string,
        options: { assertWriteAuthority?: (ptyId: string) => void }
      ) => {
        options.assertWriteAuthority?.('pty-1')
        writes.push('prompt')
        ordering.push('request-4488:generation-1:desktop:paste')
        pasteWritten()
        await settlement
        options.assertWriteAuthority?.('pty-1')
        writes.push('\r')
        ordering.push('request-4488:generation-1:mobile:enter')
        return { handle: 'terminal-1', accepted: true, bytesWritten: 7 }
      }
    )
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn(() =>
        floorOwner === 'mobile'
          ? { kind: 'mobile' as const, clientId: 'mobile-1' }
          : { kind: 'desktop' as const }
      ),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'prompt',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )
    await paste
    floorOwner = 'mobile'
    ordering.push('request-4488:generation-1:mobile:floor')
    releaseSettlement()

    await expect(response).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(writes).toEqual(['prompt'])
    expect(ordering).toEqual([
      'request-4488:generation-1:desktop:paste',
      'request-4488:generation-1:mobile:floor'
    ])
    expect(sendTerminal).not.toHaveBeenCalled()
  })
})
