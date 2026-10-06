import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import type * as ChildProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLoginShellEnvironment } from '../main/startup/login-shell-environment'
import { createFakeChild, createHandlers, requestContext } from './agent-exec-handler-test-harness'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(),
  execFile: vi.fn()
}))
vi.mock('../main/startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>()
  return { ...original, existsSync: vi.fn(original.existsSync) }
})

describe('relay headless generation shell environment', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  it('uses the execution host profile PATH and retains explicit command overrides', async () => {
    vi.mocked(resolveLoginShellEnvironment).mockResolvedValue({
      PATH: '/profile/bin:/usr/bin',
      MODEL: 'profile'
    })
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fake provides the streams and lifecycle used by the relay.
    vi.mocked(spawn).mockReturnValue(child as never)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', shell: true, env: { MODEL: 'override' } },
      requestContext()
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    child.emit('close', 0)
    await expect(pending).resolves.toMatchObject({ exitCode: 0 })
    expect(spawn).toHaveBeenLastCalledWith(
      'opencode',
      ['run'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: '/profile/bin:/usr/bin', MODEL: 'override' })
      })
    )
  })

  it('does not start generation after cancellation during profile resolution', async () => {
    vi.mocked(spawn).mockClear()
    let resolveProfile: (env: NodeJS.ProcessEnv) => void = () => {}
    vi.mocked(resolveLoginShellEnvironment).mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve
      })
    )
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', operation: 'commit-message', shell: true },
      requestContext()
    )
    await expect(
      handlers.get('agent.cancelExec')?.(
        { cwd: '/repo', operation: 'commit-message' },
        requestContext()
      )
    ).resolves.toEqual({ canceled: true })
    resolveProfile({ PATH: '/profile/bin' })
    await expect(pending).resolves.toMatchObject({ canceled: true })
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('relay generation deadline includes profile resolution', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('counts both five-second primary and fallback profile probes in the generation budget', async () => {
    vi.useFakeTimers()
    vi.mocked(resolveLoginShellEnvironment).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            setTimeout(() => resolve({ PATH: '/profile/bin' }), 5_000)
          }, 5_000)
        )
    )
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing fake supplies the relay streams and lifecycle.
    vi.mocked(spawn).mockReturnValue(child as never)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', shell: true, timeoutMs: 12_000 },
      requestContext()
    )
    let result: unknown
    void pending?.then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toMatchObject({ timedOut: true, exitCode: null })
    child.emit('close', 0)
    await pending
  })

  it('settles at the request deadline while the shared profile probe remains pending', async () => {
    vi.useFakeTimers()
    let resolveProfile: (env: NodeJS.ProcessEnv) => void = () => {}
    vi.mocked(resolveLoginShellEnvironment).mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve
      })
    )
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing fake supplies the relay streams and lifecycle.
    vi.mocked(spawn).mockReturnValue(child as never)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', shell: true, timeoutMs: 1_000 },
      requestContext()
    )
    let result: unknown
    void pending?.then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(1_000)
    try {
      expect(result).toMatchObject({ timedOut: true, exitCode: null })
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      resolveProfile({ PATH: '/profile/bin' })
      await vi.advanceTimersByTimeAsync(0)
      child.emit('close', 0)
      await pending
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'abort'] as const)(
    'settles %s immediately while the shared profile probe remains pending',
    async (kind) => {
      vi.useFakeTimers()
      let resolveProfile: (env: NodeJS.ProcessEnv) => void = () => {}
      vi.mocked(resolveLoginShellEnvironment).mockReturnValue(
        new Promise((resolve) => {
          resolveProfile = resolve
        })
      )
      const handlers = createHandlers()
      const controller = new AbortController()
      const pending = handlers.get('agent.execNonInteractive')?.(
        {
          binary: 'opencode',
          args: ['run'],
          cwd: '/repo',
          operation: 'commit-message',
          shell: true
        },
        { ...requestContext(), signal: controller.signal }
      )
      let result: unknown
      void pending?.then((value) => {
        result = value
      })
      if (kind === 'cancel') {
        await handlers.get('agent.cancelExec')?.(
          { cwd: '/repo', operation: 'commit-message' },
          requestContext()
        )
      } else {
        controller.abort()
      }
      await vi.advanceTimersByTimeAsync(0)
      try {
        expect(result).toMatchObject({ canceled: true, timedOut: false })
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        resolveProfile({ PATH: '/profile/bin' })
        await vi.advanceTimersByTimeAsync(0)
        await pending
      }
    }
  )
})

describe('relay deadline boundaries and profile failures', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('retains the final millisecond of the request budget without resetting the minimum timeout', async () => {
    vi.useFakeTimers()
    vi.mocked(resolveLoginShellEnvironment).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ PATH: '/profile/bin' }), 999))
    )
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing fake supplies the relay streams and lifecycle.
    vi.mocked(spawn).mockReturnValue(child as never)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', shell: true, timeoutMs: 1_000 },
      requestContext()
    )
    let result: unknown
    void pending?.then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toMatchObject({ timedOut: true })
    child.emit('close', 0)
    await pending
  })

  it('does not spawn when profile settlement consumes the whole request budget', async () => {
    vi.useFakeTimers()
    vi.mocked(resolveLoginShellEnvironment).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ PATH: '/profile/bin' }), 1_000))
    )
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing fake supplies the relay streams and lifecycle.
    vi.mocked(spawn).mockReturnValue(child as never)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', shell: true, timeoutMs: 1_000 },
      requestContext()
    )
    let result: unknown
    void pending?.then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(1_000)
    try {
      expect(result).toMatchObject({ timedOut: true })
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      child.emit('close', 0)
      await pending
    }
  })

  it('preserves a profile rejection and removes the pending cancellation lane', async () => {
    const failure = new Error('profile resolution refused')
    vi.mocked(resolveLoginShellEnvironment).mockRejectedValue(failure)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', operation: 'commit-message', shell: true },
      requestContext()
    )
    await expect(pending).rejects.toBe(failure)
    expect(spawn).not.toHaveBeenCalled()
    await expect(
      handlers.get('agent.cancelExec')?.(
        { cwd: '/repo', operation: 'commit-message' },
        requestContext()
      )
    ).resolves.toEqual({ canceled: false })
  })
})

describe('relay deadline covers synchronous command startup', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(existsSync).mockReset()
    vi.clearAllMocks()
  })

  it('does not spawn after a Windows PATH lookup exhausts the request budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.mocked(resolveLoginShellEnvironment).mockImplementation(() => {
      vi.setSystemTime(999)
      return Promise.resolve({ PATH: 'C:\\slow-network-bin' })
    })
    vi.mocked(existsSync).mockImplementation(() => {
      vi.setSystemTime(1_001)
      return false
    })
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing fake supplies the relay streams and lifecycle.
    vi.mocked(spawn).mockReturnValue(child as never)
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const pending = createHandlers().get('agent.execNonInteractive')?.(
        { binary: 'opencode', args: ['run'], cwd: 'C:\\repo', shell: true, timeoutMs: 1_000 },
        requestContext()
      )
      await vi.advanceTimersByTimeAsync(0)
      try {
        expect(existsSync).toHaveBeenCalled()
        expect(spawn).not.toHaveBeenCalled()
        await expect(pending).resolves.toMatchObject({ timedOut: true, exitCode: null })
      } finally {
        child.emit('close', 0)
        await pending
      }
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('times out immediately when spawning consumes the remaining request budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.mocked(existsSync).mockReturnValue(false)
    const child = createFakeChild()
    vi.mocked(spawn).mockImplementation(() => {
      vi.setSystemTime(1_001)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing fake supplies the relay streams and lifecycle.
      return child as never
    })
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', timeoutMs: 1_000 },
      requestContext()
    )
    let result: unknown
    void pending?.then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(0)
    try {
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ timedOut: true, exitCode: null })
      if (process.platform === 'win32') {
        expect(execFile).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          expect.any(Function)
        )
      } else {
        expect(child.kill).toHaveBeenCalled()
      }
      await expect(
        handlers.get('agent.cancelExec')?.({ cwd: '/repo' }, requestContext())
      ).resolves.toEqual({ canceled: false })
    } finally {
      child.emit('close', 0)
      await pending
    }
  })
})
