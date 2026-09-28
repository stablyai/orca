import type { DaemonEvent } from './types'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BunPtyProcess } from './pty-subprocess/bun-pty-process-contract'
import { DaemonTransientPtys } from './daemon-transient-pty'

vi.mock('../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: (_pid: number, fallback: () => void) => fallback()
}))

function fixture(waitForSpawn?: () => Promise<void>) {
  let output: (data: string) => void = () => {}
  let exit: (event: { exitCode: number }) => void = () => {}
  const disposeData = vi.fn()
  const disposeExit = vi.fn()
  const process = {
    pid: 123,
    kill: vi.fn(() => exit({ exitCode: 137 })),
    destroy: vi.fn(),
    write: vi.fn(),
    waitForSpawn,
    onData: vi.fn((listener: typeof output) => {
      output = listener
      return { dispose: disposeData }
    }),
    onExit: vi.fn((listener: typeof exit) => {
      exit = listener
      return { dispose: disposeExit }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Registry only accesses the explicitly supplied process members.
  const spawn = vi.fn(() => process as unknown as BunPtyProcess)
  const publish = vi.fn((_owner: string, _event: DaemonEvent) => true)
  const registry = new DaemonTransientPtys(publish, spawn, true)
  const command = {
    id: randomUUID(),
    file: '/synthetic/tool',
    args: ['a b', '$HOME'],
    cwd: '/tmp',
    env: { AUTH: 'fixture' },
    cols: 120,
    rows: 40
  }
  return {
    registry,
    command,
    process,
    spawn,
    publish,
    output: (data: string) => output(data),
    exit: (code: number) => exit({ exitCode: code }),
    disposeData,
    disposeExit
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('transient daemon PTYs', () => {
  it('rejects unsupported runtimes and unauthenticated pairs before spawning', async () => {
    const f = fixture()
    const unavailable = new DaemonTransientPtys(f.publish, f.spawn, false)
    expect(unavailable.ping()).toEqual({ pong: true })
    await expect(unavailable.create('owner', f.command)).rejects.toThrow('unavailable')
    expect(() =>
      f.registry.route(
        'owner',
        {
          id: 'request',
          type: 'createTransientPty',
          payload: f.command
        },
        false
      )
    ).toThrow('authenticated')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('passes exact argv and replacement environment, with owner-only input and cleanup', async () => {
    const f = fixture()
    await f.registry.create('owner', f.command)
    expect(f.spawn).toHaveBeenCalledWith({ ...f.command, windowsJobKillOnClose: true })
    expect(() => f.registry.write('other', f.command.id, 'secret')).toThrow('not owned')
    f.registry.write('owner', f.command.id, '/status')
    expect(f.process.write).toHaveBeenCalledWith('/status')
    f.registry.disconnect('other')
    expect(f.process.destroy).not.toHaveBeenCalled()
    f.registry.disconnect('owner')
    expect(f.process.kill).toHaveBeenCalledOnce()
    expect(f.process.destroy).toHaveBeenCalledOnce()
    expect(f.disposeData).toHaveBeenCalledOnce()
    expect(f.disposeExit).toHaveBeenCalledOnce()
  })

  it('kills a pending Windows spawn when its connection disappears', async () => {
    let finish: () => void = () => {}
    const f = fixture(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const creation = f.registry.create('owner', f.command)
    f.registry.disconnect('owner')
    finish()
    await expect(creation).rejects.toThrow('canceled')
    expect(f.process.kill).toHaveBeenCalledOnce()
    expect(f.process.destroy).toHaveBeenCalledOnce()
  })

  it('orders output before exit and does not kill a naturally exited process', async () => {
    const f = fixture()
    await f.registry.create('owner', f.command)
    f.output('hello')
    f.exit(0)
    expect(f.publish.mock.calls).toEqual([
      [
        'owner',
        { type: 'event', event: 'data', sessionId: f.command.id, payload: { data: 'hello' } }
      ],
      ['owner', { type: 'event', event: 'exit', sessionId: f.command.id, payload: { code: 0 } }]
    ])
    expect(f.process.kill).not.toHaveBeenCalled()
    expect(f.process.destroy).toHaveBeenCalledOnce()
  })

  it('retains ownership after failed signals until an actual exit is observed', async () => {
    vi.useFakeTimers()
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fixture()
    f.process.kill.mockImplementation(() => {
      throw new Error('EPERM')
    })
    await f.registry.create('owner', f.command)
    f.registry.disconnect('owner')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.process.kill).toHaveBeenCalledTimes(3)
    expect(f.process.destroy).not.toHaveBeenCalled()
    expect(f.publish.mock.calls.some(([, event]) => event.event === 'exit')).toBe(false)
    await expect(f.registry.create('owner', f.command)).rejects.toThrow('already exists')
    f.exit(137)
    expect(f.process.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    warnings.mockRestore()
  })

  it('terminates on overflow and bounds unattended lifetime', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.registry.create('owner', f.command)
    f.publish.mockReturnValue(false)
    f.output('flood')
    expect(f.process.destroy).toHaveBeenCalledOnce()
    const g = fixture()
    await g.registry.create('owner', g.command)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(g.process.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects new probes after shutdown starts', async () => {
    const f = fixture()
    f.registry.dispose()
    await expect(f.registry.create('owner', f.command)).rejects.toThrow('shutting down')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('does not kill only the Windows gate after job termination fails', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const f = fixture()
      const terminateOwnedTree = vi.fn(() => 'unavailable')
      Object.assign(f.process, { terminateOwnedTree })
      await f.registry.create('owner', f.command)
      f.registry.disconnect('owner')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(terminateOwnedTree).toHaveBeenCalledTimes(3)
      expect(f.process.kill).not.toHaveBeenCalled()
      expect(f.process.destroy).not.toHaveBeenCalled()
      await expect(f.registry.create('owner', f.command)).rejects.toThrow('already exists')
      f.exit(1)
    } finally {
      warning.mockRestore()
    }
  })
})
