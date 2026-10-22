import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { OrcaRuntimeService } from '../orca-runtime'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

async function subscribe(client: { id: string; type: 'mobile' | 'desktop' }, binary: boolean) {
  const noteTerminalUse = vi.fn()
  const runtime = stubRuntime({
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach hook reads only terminalUse.noteTerminalUse.
    sidebarFacts: {
      terminalUse: { noteTerminalUse }
    } as unknown as OrcaRuntimeService['sidebarFacts']
  })
  const controller = new AbortController()
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const done = dispatcher.dispatchStreaming(
    makeRequest('terminal.subscribe', {
      terminal: 'terminal-1',
      client,
      ...(binary ? { capabilities: { terminalBinaryStream: 1 } } : {})
    }),
    () => {},
    {
      signal: controller.signal,
      connectionId: `conn-${client.id}`,
      ...(binary ? { sendBinary: () => {}, registerBinaryStreamHandler: () => () => {} } : {})
    }
  )
  await vi.waitFor(() => expect(runtime.resolveLeafForHandle).toHaveBeenCalled())
  controller.abort()
  await done.catch(() => {})
  return noteTerminalUse
}

describe('terminal.subscribe terminal use', () => {
  it('a phone opening a terminal records use of its workspace', async () => {
    const note = await subscribe({ id: 'phone-1', type: 'mobile' }, true)
    expect(note).toHaveBeenCalledWith('pty-1', expect.any(Number))
  })

  it('a desktop subscriber does not', async () => {
    const note = await subscribe({ id: 'desktop-1', type: 'desktop' }, false)
    expect(note).not.toHaveBeenCalled()
  })
})
