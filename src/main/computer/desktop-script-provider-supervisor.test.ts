import type { ExecFileException } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_PROVIDER_MAX_BUFFER_BYTES,
  type DesktopScriptProviderSupervisorDeps
} from './desktop-script-provider-process-invocation'
import {
  DESKTOP_PROVIDER_FORCE_KILL_GRACE_MS,
  DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS,
  DesktopScriptProviderSupervisor
} from './desktop-script-provider-supervisor'

type ExecCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321
  kill = vi.fn(() => true)
}

function deferred<T>() {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushPreparation(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve()
  }
}

describe('DesktopScriptProviderSupervisor', () => {
  let callback: ExecCallback | null
  let child: FakeChild
  let deps: DesktopScriptProviderSupervisorDeps

  beforeEach(() => {
    vi.useFakeTimers()
    callback = null
    child = new FakeChild()
    deps = {
      platform: vi.fn<DesktopScriptProviderSupervisorDeps['platform']>(() => 'linux'),
      resolveScriptPath: vi.fn(() => '/fixed/runtime.py'),
      execFile: vi.fn((_command, _args, _options, execCallback) => {
        callback = execCallback as ExecCallback
        return child as never
      }) as never,
      randomUUID: vi.fn(() => 'operation-1'),
      temporaryDirectory: vi.fn(() => '/private/tmp'),
      mkdtemp: vi.fn(
        async () => '/private/tmp/orca-computer-use-operation'
      ) as unknown as DesktopScriptProviderSupervisorDeps['mkdtemp'],
      chmod: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rmSync: vi.fn(),
      setTimer: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      clearTimer: (timer) => clearTimeout(timer)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('constructs the fixed Linux invocation and waits for callback plus exit', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    await flushPreparation()

    const operationPath = join('/private/tmp/orca-computer-use-operation', 'operation.json')
    expect(deps.mkdtemp).toHaveBeenCalledWith(join('/private/tmp', 'orca-computer-use-'))
    expect(deps.chmod).toHaveBeenCalledWith('/private/tmp/orca-computer-use-operation', 0o700)
    expect(deps.writeFile).toHaveBeenCalledWith(operationPath, '{"tool":"list_apps"}', {
      encoding: 'utf8',
      mode: 0o600
    })
    expect(deps.execFile).toHaveBeenCalledWith(
      'python3',
      ['/fixed/runtime.py', operationPath],
      expect.objectContaining({
        encoding: 'utf8',
        maxBuffer: DESKTOP_PROVIDER_MAX_BUFFER_BYTES,
        windowsHide: true
      }),
      expect.any(Function)
    )

    callback!(null, '{"ok":true}', '')
    let settled = false
    void result.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(deps.rmSync).not.toHaveBeenCalled()

    child.emit('exit', 0, null)
    await expect(result).resolves.toEqual({
      stdout: '{"ok":true}',
      stderr: '',
      error: null
    })
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-operation', {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    })
  })

  it('waits for the exec callback when exit arrives first', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    await flushPreparation()

    child.emit('exit', 0, null)
    let settled = false
    void result.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(deps.rmSync).not.toHaveBeenCalled()

    callback!(null, '{"ok":true}', '')
    await expect(result).resolves.toMatchObject({ error: null })
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
  })

  it('reuses the main-selected platform, script, and environment plan', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const first = supervisor.execute({ tool: 'list_apps' })
    await flushPreparation()
    callback!(null, '{"ok":true}', '')
    child.emit('exit', 0, null)
    await first

    const second = supervisor.execute({ tool: 'list_apps' })
    await flushPreparation()
    callback!(null, '{"ok":true}', '')
    child.emit('exit', 0, null)
    await second

    expect(deps.platform).toHaveBeenCalledTimes(1)
    expect(deps.resolveScriptPath).toHaveBeenCalledTimes(1)
    expect(deps.execFile).toHaveBeenCalledTimes(2)
  })

  it('escalates a Linux deadline while retaining state until confirmed exit', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toMatchObject({ code: 'action_timeout' })
    await flushPreparation()

    await vi.advanceTimersByTimeAsync(DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS)
    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(deps.rmSync).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(1)

    await vi.advanceTimersByTimeAsync(DESKTOP_PROVIDER_FORCE_KILL_GRACE_MS)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(deps.rmSync).not.toHaveBeenCalled()

    child.emit('exit', null, 'SIGKILL')
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('cancels Linux force escalation after the timed-out child exits', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toMatchObject({ code: 'action_timeout' })
    await flushPreparation()

    await vi.advanceTimersByTimeAsync(DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS)
    await rejection
    child.emit('exit', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(DESKTOP_PROVIDER_FORCE_KILL_GRACE_MS)

    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
  })

  it('uses forceful Windows termination without POSIX signal escalation', async () => {
    vi.mocked(deps.platform).mockReturnValue('windows')
    vi.mocked(deps.resolveScriptPath).mockReturnValue('/fixed/runtime.ps1')
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toMatchObject({ code: 'action_timeout' })
    await flushPreparation()

    expect(deps.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        '/fixed/runtime.ps1',
        join('/private/tmp/orca-computer-use-operation', 'operation.json')
      ],
      expect.any(Object),
      expect.any(Function)
    )
    await vi.advanceTimersByTimeAsync(DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS)
    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(DESKTOP_PROVIDER_FORCE_KILL_GRACE_MS)
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', null, 'SIGTERM')
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
  })

  it('cancels an operation before directory creation completes', async () => {
    const directory = deferred<string>()
    vi.mocked(deps.mkdtemp).mockReturnValueOnce(directory.promise)
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toThrow('supervisor shut down')

    supervisor.shutdown()
    await rejection
    expect(deps.execFile).not.toHaveBeenCalled()

    directory.resolve('/private/tmp/orca-computer-use-late')
    await flushPreparation()
    expect(deps.rmSync).toHaveBeenCalledWith('/private/tmp/orca-computer-use-late', {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    })
    expect(deps.execFile).not.toHaveBeenCalled()
  })

  it('cancels after directory creation without spawning after an async setup resumes', async () => {
    const chmod = deferred<void>()
    vi.mocked(deps.chmod).mockReturnValueOnce(chmod.promise)
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toThrow('supervisor shut down')
    await flushPreparation()
    expect(deps.chmod).toHaveBeenCalled()

    supervisor.shutdown()
    await rejection
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
    chmod.resolve()
    await flushPreparation()
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.execFile).not.toHaveBeenCalled()
  })

  it('retains a spawned operation and its file until shutdown confirms exit', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toThrow('supervisor shut down')
    await flushPreparation()

    supervisor.shutdown()
    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(deps.rmSync).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(1)

    child.emit('exit', null, 'SIGKILL')
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('handles a child without a pid and retains an asynchronous error listener', async () => {
    child.pid = undefined
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    await flushPreparation()

    await expect(result).rejects.toThrow('did not report a pid')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
    expect(() => child.emit('error', new Error('spawn failed asynchronously'))).not.toThrow()
  })

  it('rejects a registered child error but cleans up only after exit', async () => {
    const supervisor = new DesktopScriptProviderSupervisor(deps)
    const result = supervisor.execute({ tool: 'list_apps' })
    const rejection = expect(result).rejects.toThrow('provider failed: handle failed')
    await flushPreparation()

    child.emit('error', new Error('handle failed'))
    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(deps.rmSync).not.toHaveBeenCalled()

    child.emit('exit', null, 'SIGKILL')
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
  })

  it('removes the private directory when setup fails before spawn', async () => {
    vi.mocked(deps.writeFile).mockRejectedValueOnce(new Error('operation write failed'))
    const supervisor = new DesktopScriptProviderSupervisor(deps)

    await expect(supervisor.execute({ tool: 'list_apps' })).rejects.toThrow(
      'operation write failed'
    )
    expect(deps.execFile).not.toHaveBeenCalled()
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
  })
})
