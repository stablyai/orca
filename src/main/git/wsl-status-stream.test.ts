import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslStatusEnvironmentModule from './wsl-status-environment'
import type * as WslStatusRunnerModule from './wsl-status-runner'

const {
  gitStreamStdoutMock,
  invalidateEnvironmentMock,
  killSpawnedCommandTreeMock,
  readEnvironmentMock,
  wslAwareSpawnMock
} = vi.hoisted(() => ({
  gitStreamStdoutMock: vi.fn(),
  invalidateEnvironmentMock: vi.fn(),
  killSpawnedCommandTreeMock: vi.fn(),
  readEnvironmentMock: vi.fn(),
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_details: unknown, operation: () => unknown) => operation()
}))

vi.mock('./runner', () => ({
  DEFAULT_GIT_MAX_BUFFER: 1024,
  commandExecFileAsync: vi.fn(),
  extractExecError: (error: unknown) => {
    const detail = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
    return {
      stderr:
        typeof detail?.stderr === 'string'
          ? detail.stderr
          : typeof detail?.message === 'string'
            ? detail.message
            : '',
      stdout: typeof detail?.stdout === 'string' ? detail.stdout : ''
    }
  },
  gitExecFileAsync: vi.fn(),
  gitStreamStdout: gitStreamStdoutMock,
  killSpawnedCommandTree: killSpawnedCommandTreeMock,
  nonInteractiveGitEnv: (env: NodeJS.ProcessEnv = {}) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
  }),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('./wsl-status-environment', async (importOriginal) => {
  const actual = await importOriginal<typeof WslStatusEnvironmentModule>()
  return { ...actual, invalidateWslStatusEnvironment: invalidateEnvironmentMock }
})

vi.mock('./wsl-status-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof WslStatusRunnerModule>()
  return { ...actual, readWslStatusEnvironment: readEnvironmentMock }
})

import { gitStatusStreamStdout } from './wsl-status-stream'

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
}

const environment = {
  gitPath: '/opt/git/bin/git',
  path: '/opt/git/bin:/usr/bin:/bin'
}

function createChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function streamOptions(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '\\\\wsl.localhost\\Ubuntu\\repo',
    onStdout: vi.fn(),
    ...overrides
  }
}

async function waitForSpawn(count: number): Promise<void> {
  await vi.waitFor(() => expect(wslAwareSpawnMock).toHaveBeenCalledTimes(count))
}

function queueChildren(...children: MockChildProcess[]): void {
  wslAwareSpawnMock.mockImplementation(() => children.shift())
}

describe('gitStatusStreamStdout', () => {
  const originalPlatform = process.platform

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  beforeEach(() => {
    gitStreamStdoutMock.mockReset()
    invalidateEnvironmentMock.mockReset()
    killSpawnedCommandTreeMock.mockReset()
    readEnvironmentMock.mockReset()
    wslAwareSpawnMock.mockReset()
    readEnvironmentMock.mockResolvedValue(environment)
  })

  it('delegates native worktrees to the existing stream runner', async () => {
    const options = streamOptions({ cwd: 'C:\\repo' })
    gitStreamStdoutMock.mockResolvedValue({ stoppedEarly: true })

    await expect(gitStatusStreamStdout(['status'], options)).resolves.toEqual({
      stoppedEarly: true
    })

    expect(gitStreamStdoutMock).toHaveBeenCalledWith(['status'], options)
    expect(readEnvironmentMock).not.toHaveBeenCalled()
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('uses a guarded login shell when environment resolution is unavailable', async () => {
    const child = createChild()
    const onStdout = vi.fn()
    readEnvironmentMock.mockResolvedValue(null)
    queueChildren(child)

    const promise = gitStatusStreamStdout(['status', '--porcelain=v2'], streamOptions({ onStdout }))
    await waitForSpawn(1)
    child.stdout.emit('data', Buffer.from('1 .M file.txt\n'))
    child.emit('close', 0)

    await expect(promise).resolves.toEqual({ stoppedEarly: false })
    expect(onStdout).toHaveBeenCalledWith('1 .M file.txt\n')
    const args = wslAwareSpawnMock.mock.calls[0][1] as string[]
    const command = args.join(' ')
    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', '/bin/sh', '-lc'])
    expect(command).toContain(String.raw`GIT_OPTIONAL_LOCKS='\''0'\''`)
    expect(command).toContain(String.raw`GIT_TERMINAL_PROMPT='\''0'\''`)
    expect(command).toContain('GIT_ASKPASS=')
    expect(command).toContain('SSH_ASKPASS=')
    expect(command).toContain(String.raw`GCM_INTERACTIVE='\''never'\''`)
  })

  it.each([126, 127])(
    'retries cached Git exit %i once through the login shell before stdout',
    async (exitCode) => {
      const direct = createChild()
      const fallback = createChild()
      queueChildren(direct, fallback)

      const promise = gitStatusStreamStdout(['status'], streamOptions())
      await waitForSpawn(1)
      direct.stderr.emit(
        'data',
        Buffer.from('orca-wsl-status-cached-git-unavailable:/opt/git/bin/git\n')
      )
      direct.emit('close', exitCode)
      await waitForSpawn(2)
      fallback.emit('close', 0)

      await expect(promise).resolves.toEqual({ stoppedEarly: false })
      expect(wslAwareSpawnMock).toHaveBeenCalledTimes(2)
      expect(invalidateEnvironmentMock).toHaveBeenCalledWith('Ubuntu', environment)
      const directArgs = wslAwareSpawnMock.mock.calls[0][1] as string[]
      const fallbackArgs = wslAwareSpawnMock.mock.calls[1][1] as string[]
      expect(directArgs[4]).toBe('-c')
      expect(fallbackArgs[4]).toBe('-lc')
    }
  )

  it('does not retry a cached-launch error after streaming any stdout', async () => {
    const child = createChild()
    const onStdout = vi.fn()
    queueChildren(child)

    const promise = gitStatusStreamStdout(['status'], streamOptions({ onStdout }))
    const rejection = expect(promise).rejects.toMatchObject({ code: 127, sawStdout: true })
    await waitForSpawn(1)
    child.stdout.emit('data', Buffer.from('partial'))
    child.stderr.emit(
      'data',
      Buffer.from('orca-wsl-status-cached-git-unavailable:/opt/git/bin/git\n')
    )
    child.emit('close', 127)

    await rejection
    expect(onStdout).toHaveBeenCalledWith('partial')
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    expect(invalidateEnvironmentMock).not.toHaveBeenCalled()
  })

  it('kills an active WSL command and rejects on abort without retrying', async () => {
    const child = createChild()
    const controller = new AbortController()
    queueChildren(child)

    const promise = gitStatusStreamStdout(['status'], streamOptions({ signal: controller.signal }))
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await waitForSpawn(1)
    controller.abort()

    await rejection
    expect(killSpawnedCommandTreeMock).toHaveBeenCalledWith(child)
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    expect(invalidateEnvironmentMock).not.toHaveBeenCalled()
  })

  it('enforces maxBuffer without falling back', async () => {
    const child = createChild()
    queueChildren(child)

    const promise = gitStatusStreamStdout(['status'], streamOptions({ maxBuffer: 3 }))
    const rejection = expect(promise).rejects.toThrow('git stdout exceeded maxBuffer.')
    await waitForSpawn(1)
    child.stdout.emit('data', Buffer.from('four'))

    await rejection
    expect(killSpawnedCommandTreeMock).toHaveBeenCalledWith(child)
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    expect(invalidateEnvironmentMock).not.toHaveBeenCalled()
  })

  it('does not retry non-Git spawn errors', async () => {
    const child = createChild()
    const spawnError = new Error('wsl.exe could not start')
    queueChildren(child)

    const promise = gitStatusStreamStdout(['status'], streamOptions())
    const rejection = expect(promise).rejects.toBe(spawnError)
    await waitForSpawn(1)
    child.emit('error', spawnError)

    await rejection
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    expect(invalidateEnvironmentMock).not.toHaveBeenCalled()
  })
})
