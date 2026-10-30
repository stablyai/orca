import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_PROBE_SHUTDOWN_DRAIN_MS, terminateCodexProbeChild } from './codex-probe-termination'

function makeFakeChild() {
  const emitter = new EventEmitter()
  const child = {
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: { end: vi.fn() },
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    exit(code = 0) {
      child.exitCode = code
      emitter.emit('exit')
    },
    error() {
      emitter.emit('error', new Error('signal delivery failed'))
    }
  }
  return child
}

describe('terminateCodexProbeChild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requests shutdown and never hard-kills a child that drains in time', async () => {
    const child = makeFakeChild()
    const done = terminateCodexProbeChild(child, { platform: 'darwin' })

    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(CODEX_PROBE_SHUTDOWN_DRAIN_MS - 1)
    child.exit()
    await done

    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('escalates to SIGKILL only after the drain window elapses', async () => {
    const child = makeFakeChild()
    const done = terminateCodexProbeChild(child, { platform: 'linux' })

    await vi.advanceTimersByTimeAsync(CODEX_PROBE_SHUTDOWN_DRAIN_MS)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    child.exit()
    await done
    expect(child.kill.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('resolves within the hard-kill bound even if the child never reports exit', async () => {
    const child = makeFakeChild()
    let settled = false
    const done = terminateCodexProbeChild(child, { platform: 'linux' }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(CODEX_PROBE_SHUTDOWN_DRAIN_MS + 1_000)
    await done
    expect(settled).toBe(true)
  })

  it('does not treat a child error as proof that the process exited', async () => {
    const child = makeFakeChild()
    let settled = false
    const done = terminateCodexProbeChild(child, { platform: 'linux' }).then(() => {
      settled = true
    })

    child.error()
    await Promise.resolve()
    expect(settled).toBe(false)

    child.exit()
    await done
    expect(settled).toBe(true)
  })

  it('sends no signal during the drain window on Windows where kill is always forceful', async () => {
    const child = makeFakeChild()
    const killWindowsProcessTree = vi.fn(async () => {})
    const done = terminateCodexProbeChild(child, { platform: 'win32', killWindowsProcessTree })

    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CODEX_PROBE_SHUTDOWN_DRAIN_MS)
    expect(killWindowsProcessTree).toHaveBeenCalledWith(child.pid, {
      site: 'codex-rate-limit-probe'
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith()

    child.exit()
    await done
  })

  it('waits for the Windows descendant tree kill before releasing the probe', async () => {
    const child = makeFakeChild()
    let finishTreeKill!: () => void
    const treeKill = new Promise<void>((resolve) => {
      finishTreeKill = resolve
    })
    const killWindowsProcessTree = vi.fn(() => treeKill)
    let settled = false
    const done = terminateCodexProbeChild(child, {
      platform: 'win32',
      drainMs: 0,
      killWindowsProcessTree
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(killWindowsProcessTree).toHaveBeenCalledWith(child.pid, {
      site: 'codex-rate-limit-probe'
    })
    child.exit()
    await Promise.resolve()
    expect(settled).toBe(false)

    finishTreeKill()
    await done
    expect(settled).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does nothing for a child that already exited', async () => {
    const child = makeFakeChild()
    child.exit()

    await terminateCodexProbeChild(child, { platform: 'darwin' })

    expect(child.stdin.end).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
