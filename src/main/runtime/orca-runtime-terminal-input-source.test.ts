import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../shared/terminal-input'

function makeRuntime() {
  const deviceNames: Record<string, string> = { 'device-laptop': 'book-laptop' }
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getPairedDeviceName: (pairedDeviceId) => deviceNames[pairedDeviceId] ?? null
  })
  return { runtime, deviceNames }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrcaRuntimeService terminal input source', () => {
  it('reports nothing for a PTY nobody has written to', () => {
    const { runtime } = makeRuntime()
    expect(runtime.getTerminalInputSource('pty-1')).toBeNull()
  })

  it('keeps the latest caller per PTY and resolves the device name on read', () => {
    const { runtime, deviceNames } = makeRuntime()
    runtime.recordTerminalInputSource('pty-1', {
      pairedDeviceId: 'device-phone',
      clientKind: 'mobile'
    })
    runtime.recordTerminalInputSource('pty-1', {
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    })
    runtime.recordTerminalInputSource('pty-2', {
      pairedDeviceId: 'device-phone',
      clientKind: 'mobile'
    })

    expect(runtime.getTerminalInputSource('pty-1')).toEqual({
      pairedDeviceId: 'device-laptop',
      deviceName: 'book-laptop',
      clientKind: 'runtime',
      at: expect.any(Number)
    })
    expect(runtime.getTerminalInputSource('pty-2')).toMatchObject({
      pairedDeviceId: 'device-phone',
      deviceName: null,
      clientKind: 'mobile'
    })

    deviceNames['device-laptop'] = 'renamed-laptop'
    expect(runtime.getTerminalInputSource('pty-1')?.deviceName).toBe('renamed-laptop')
  })

  it('classifies any caller without a paired device as local, whatever its clientKind', () => {
    const { runtime } = makeRuntime()
    // Why: the desktop renderer dispatches over IPC as clientKind 'runtime' with no device.
    runtime.recordTerminalInputSource('pty-1', { clientKind: 'runtime' })
    expect(runtime.getTerminalInputSource('pty-1')).toMatchObject({
      pairedDeviceId: null,
      deviceName: null,
      clientKind: 'local'
    })
    runtime.recordTerminalInputSource('pty-2', {})
    expect(runtime.getTerminalInputSource('pty-2')?.clientKind).toBe('local')
  })

  it('sendTerminal records the PTY the write hook reports, after the write', async () => {
    const { runtime } = makeRuntime()
    const afterWrite = vi.fn()
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminal').mockImplementation(
      async (handle, _action, options = {}) => {
        expect(runtime.getTerminalInputSource('pty-written')).toBeNull()
        await options.afterWrite?.('pty-written')
        return { handle, accepted: true, bytesWritten: 3 }
      }
    )

    const result = await runtime.sendTerminal(
      'term-1',
      { text: 'ls' },
      {
        afterWrite,
        inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
      }
    )

    expect(result.accepted).toBe(true)
    expect(afterWrite).toHaveBeenCalledWith('pty-written')
    expect(runtime.getTerminalInputSource('pty-written')).toMatchObject({
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    })
  })

  it('sendTerminal records nothing when the write hook never fires or no source is given', async () => {
    const { runtime } = makeRuntime()
    const send = vi
      .spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminal')
      .mockImplementation(async (handle) => ({ handle, accepted: false, bytesWritten: 0 }))

    await runtime.sendTerminal('term-1', { text: 'ls' }, { inputSource: { pairedDeviceId: 'd' } })
    await runtime.sendTerminal('term-1', { text: 'ls' })

    expect(runtime.getTerminalInputSource('pty-written')).toBeNull()
    expect(send.mock.calls[1]?.[2]).toEqual({})
  })

  it('sendTerminalAgentPrompt records the PTY seen by beforeWrite once the prompt is accepted', async () => {
    const { runtime } = makeRuntime()
    const beforeWrite = vi.fn()
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options = {}) => {
        await options.beforeWrite?.('pty-prompt')
        return { handle, accepted: true, bytesWritten: 5 }
      }
    )

    await runtime.sendTerminalAgentPrompt('term-1', 'hello', {
      beforeWrite,
      inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' }
    })

    expect(beforeWrite).toHaveBeenCalledWith('pty-prompt')
    expect(runtime.getTerminalInputSource('pty-prompt')).toMatchObject({
      pairedDeviceId: 'device-phone',
      clientKind: 'mobile'
    })
  })

  it('sendTerminalAgentPrompt records nothing for a refused prompt', async () => {
    const { runtime } = makeRuntime()
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options = {}) => {
        await options.beforeWrite?.('pty-prompt')
        return { handle, accepted: false, bytesWritten: 0 }
      }
    )

    await runtime.sendTerminalAgentPrompt('term-1', 'hello', {
      inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' }
    })

    expect(runtime.getTerminalInputSource('pty-prompt')).toBeNull()
  })

  it('forgets the source when the PTY is torn down', () => {
    const { runtime } = makeRuntime()
    runtime.recordTerminalInputSource('pty-1', {
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    })
    // Why reach into the protected teardown hook: every PTY teardown path funnels through it,
    // and driving a full PTY exit needs a provider this unit test does not own.
    const teardown = runtime as unknown as { disposePtyTitleTracker(ptyId: string): void }
    teardown.disposePtyTitleTracker('pty-1')
    expect(runtime.getTerminalInputSource('pty-1')).toBeNull()
  })
})

describe('OrcaRuntimeService terminal input source through the real writer', () => {
  // Why drive RuntimeTerminalWriter for real: it fires afterWrite once per chunk, so the
  // override must not record from the hook itself or a paste refused on a later chunk would
  // still name its sender.
  function runtimeWithWriter(write: (ptyId: string, data: string) => boolean) {
    const { runtime } = makeRuntime()
    const writer = new RuntimeTerminalWriter(write)
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminal').mockImplementation(
      async (handle, action, options = {}) => {
        const payload = (action.text ?? '') + (action.enter ? '\r' : '')
        await writer.writeAction('pty-real', action, payload, options)
        return { handle, accepted: true, bytesWritten: Buffer.byteLength(payload) }
      }
    )
    return runtime
  }

  it('records once after every chunk of a large paste was written', async () => {
    const writes: number[] = []
    const runtime = runtimeWithWriter((_ptyId, data) => {
      writes.push(data.length)
      return true
    })

    await runtime.sendTerminal(
      'term-1',
      { text: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8) },
      { inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' } }
    )

    expect(writes).toHaveLength(3)
    expect(runtime.getTerminalInputSource('pty-real')).toMatchObject({
      pairedDeviceId: 'device-phone',
      clientKind: 'mobile'
    })
  })

  it('records nothing when a later chunk is refused', async () => {
    let writes = 0
    const runtime = runtimeWithWriter(() => {
      writes += 1
      return writes < 3
    })

    await expect(
      runtime.sendTerminal(
        'term-1',
        { text: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8) },
        { inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' } }
      )
    ).rejects.toThrow('terminal_not_writable')

    expect(writes).toBe(3)
    expect(runtime.getTerminalInputSource('pty-real')).toBeNull()
  })

  it('records nothing when the Enter suffix is refused after the text went through', async () => {
    const runtime = runtimeWithWriter((_ptyId, data) => data !== '\r')

    await expect(
      runtime.sendTerminal(
        'term-1',
        { text: 'ls', enter: true },
        { inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' } }
      )
    ).rejects.toThrow('terminal_not_writable')

    expect(runtime.getTerminalInputSource('pty-real')).toBeNull()
  })
})

describe('OrcaRuntimeService terminal input source on the orchestration checkpoint', () => {
  it('records when onInputAccepted fires even if the prompt call later throws', async () => {
    const { runtime } = makeRuntime()
    const onInputAccepted = vi.fn()
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options = {}) => {
        await options.beforeWrite?.('pty-prompt')
        options.onInputAccepted?.({ handle, accepted: true, bytesWritten: 6 })
        throw new Error('agent_prompt_observation_aborted')
      }
    )

    await expect(
      runtime.sendTerminalAgentPrompt('term-1', 'hello', {
        acceptQueued: true,
        requestId: 'req-1',
        onInputAccepted,
        inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
      })
    ).rejects.toThrow('agent_prompt_observation_aborted')

    expect(onInputAccepted).toHaveBeenCalledTimes(1)
    expect(runtime.getTerminalInputSource('pty-prompt')).toMatchObject({
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    })
  })
})
