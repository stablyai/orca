import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

function makeRuntime() {
  const deviceNames: Record<string, string> = { 'device-laptop': 'book-laptop' }
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getPairedDeviceName: (pairedDeviceId) => deviceNames[pairedDeviceId] ?? null
  })
  return { runtime, deviceNames }
}

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

  it('treats a caller without RPC identity as in-process', () => {
    const { runtime } = makeRuntime()
    runtime.recordTerminalInputSource('pty-1', {})
    expect(runtime.getTerminalInputSource('pty-1')).toMatchObject({
      pairedDeviceId: null,
      deviceName: null,
      clientKind: 'local'
    })
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
