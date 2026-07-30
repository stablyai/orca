import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MACOS_HELPER_CLAIM_TIMEOUT_MS,
  MACOS_HELPER_FORCE_KILL_GRACE_MS,
  MacOSNativeProviderSupervisor,
  type MacOSNativeProviderSupervisorDeps
} from './macos-native-provider-supervisor'

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321
  kill = vi.fn(() => true)
  unref = vi.fn()
}

describe('MacOSNativeProviderSupervisor', () => {
  let child: FakeChild
  let deps: MacOSNativeProviderSupervisorDeps
  let events: unknown[]

  beforeEach(() => {
    vi.useFakeTimers()
    child = new FakeChild()
    events = []
    let uuid = 0
    deps = {
      resolveExecutablePath: vi.fn(
        () => '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
      ),
      spawn: vi.fn(() => child as never),
      randomUUID: vi.fn(() => `uuid-${++uuid}`),
      mkdtempSync: vi.fn(
        () => '/private/tmp/orca-computer-use-session'
      ) as unknown as MacOSNativeProviderSupervisorDeps['mkdtempSync'],
      chmodSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
      setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
      clearTimer: (timer) => clearTimeout(timer)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers the helper pid and private session state before returning', () => {
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)

    const started = supervisor.start(7654)

    expect(started).toEqual({
      sessionId: 'uuid-2',
      socketPath: join('/private/tmp/orca-computer-use-session', 'provider.sock'),
      socketToken: 'uuid-1'
    })
    expect(deps.spawn).toHaveBeenCalledWith(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos',
      [
        '--agent',
        join('/private/tmp/orca-computer-use-session', 'provider.sock'),
        '--token-file',
        join('/private/tmp/orca-computer-use-session', 'provider.token'),
        '--peer-pid',
        '7654'
      ],
      { detached: true, stdio: 'ignore' }
    )
    expect(deps.chmodSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-session', 0o700)
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      join('/private/tmp/orca-computer-use-session', 'provider.token'),
      'uuid-1',
      { encoding: 'utf8', mode: 0o600 }
    )
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])
  })

  it('claims a live session and removes only its token file', async () => {
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)
    const started = supervisor.start(7654)

    supervisor.claim(started.sessionId)
    await vi.advanceTimersByTimeAsync(MACOS_HELPER_CLAIM_TIMEOUT_MS)

    expect(deps.rmSync).toHaveBeenCalledWith(
      join('/private/tmp/orca-computer-use-session', 'provider.token'),
      { force: true }
    )
    expect(child.kill).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('reaps an unclaimed helper and removes private state on the parent deadline', async () => {
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)
    supervisor.start(7654)

    await vi.advanceTimersByTimeAsync(MACOS_HELPER_CLAIM_TIMEOUT_MS)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-session', {
      recursive: true,
      force: true
    })
    expect(events).toEqual([
      expect.objectContaining({
        event: 'macos.sessionTerminated',
        sessionId: 'uuid-2',
        error: expect.objectContaining({ message: expect.stringContaining('not claimed') })
      })
    ])

    await vi.advanceTimersByTimeAsync(MACOS_HELPER_FORCE_KILL_GRACE_MS)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(child.listenerCount('exit')).toBe(1)
    child.emit('exit', null, 'SIGKILL')
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('releases a claimed session with graceful-to-force escalation', async () => {
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)
    const started = supervisor.start(7654)
    supervisor.claim(started.sessionId)

    supervisor.release(started.sessionId)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-session', {
      recursive: true,
      force: true
    })
    await vi.advanceTimersByTimeAsync(MACOS_HELPER_FORCE_KILL_GRACE_MS)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(child.listenerCount('exit')).toBe(1)
    child.emit('exit', null, 'SIGKILL')
    expect(child.listenerCount('exit')).toBe(0)
    expect(events).toEqual([])
  })

  it('kills every registered helper immediately when its sidecar owner dies', () => {
    const first = child
    const second = new FakeChild()
    second.pid = 4322
    vi.mocked(deps.spawn)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never)
    vi.mocked(deps.mkdtempSync)
      .mockReturnValueOnce('/private/tmp/orca-computer-use-first')
      .mockReturnValueOnce('/private/tmp/orca-computer-use-second')
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)
    supervisor.start(7654)
    supervisor.start(7654)

    supervisor.shutdown()

    expect(first.kill).toHaveBeenCalledWith('SIGKILL')
    expect(second.kill).toHaveBeenCalledWith('SIGKILL')
    expect(first.listenerCount('exit')).toBe(1)
    expect(second.listenerCount('exit')).toBe(1)
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-first', {
      recursive: true,
      force: true
    })
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-second', {
      recursive: true,
      force: true
    })
    first.emit('exit', null, 'SIGKILL')
    second.emit('exit', null, 'SIGKILL')
    expect(first.listenerCount('exit')).toBe(0)
    expect(second.listenerCount('exit')).toBe(0)
  })

  it('reports unexpected helper exit and removes its private directory', () => {
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)
    supervisor.start(7654)

    child.emit('exit', 13, null)

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'uuid-2',
        error: expect.objectContaining({ message: expect.stringContaining('code 13') })
      })
    ])
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-session', {
      recursive: true,
      force: true
    })
  })

  it('reports a registered helper error and retains ownership until exit', () => {
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)
    const started = supervisor.start(7654)

    child.emit('error', new Error('helper handle failed'))

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: started.sessionId,
        error: expect.objectContaining({ message: expect.stringContaining('helper handle failed') })
      })
    ])
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.listenerCount('exit')).toBe(1)
    expect(() => supervisor.claim(started.sessionId)).toThrow('no longer active')

    child.emit('exit', null, 'SIGKILL')
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('does not publish a session when spawn returns no pid', () => {
    child.pid = undefined
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)

    expect(() => supervisor.start(7654)).toThrow('helper process did not report a pid')

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-session', {
      recursive: true,
      force: true
    })
    expect(() => child.emit('error', new Error('spawn failed asynchronously'))).not.toThrow()
    expect(events).toEqual([])
  })

  it('removes the private directory when token setup fails before spawn', () => {
    vi.mocked(deps.writeFileSync).mockImplementationOnce(() => {
      throw new Error('token write failed')
    })
    const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)

    expect(() => supervisor.start(7654)).toThrow('token write failed')

    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-session', {
      recursive: true,
      force: true
    })
  })

  it.each([0, -1, 1.5, Number.NaN, 0x80000000])(
    'rejects invalid expected peer pid %s before creating private state',
    (expectedPeerProcessId) => {
      const supervisor = new MacOSNativeProviderSupervisor((event) => events.push(event), deps)

      expect(() => supervisor.start(expectedPeerProcessId)).toThrow(
        'owner process did not report a valid pid'
      )
      expect(deps.mkdtempSync).not.toHaveBeenCalled()
      expect(deps.spawn).not.toHaveBeenCalled()
      expect(events).toEqual([])
    }
  )
})
