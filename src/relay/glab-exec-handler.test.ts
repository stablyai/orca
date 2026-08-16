import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import type { RelayDispatcher } from './dispatcher'
import { GlabExecHandler } from './glab-exec-handler'
import { GLAB_EXEC_METHOD } from '../shared/ssh-types'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn()
  }
})

const spawnMock = vi.mocked(spawn)

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.pid = 4242
  child.kill = vi.fn()
  return child
}

function createHandler(): {
  get: (
    method: string
  ) => ((params: Record<string, unknown>, context?: unknown) => Promise<unknown>) | undefined
} {
  const handlers = new Map<
    string,
    (params: Record<string, unknown>, context?: unknown) => Promise<unknown>
  >()
  const dispatcher = {
    onRequest: (
      method: string,
      handler: (params: Record<string, unknown>, context?: unknown) => Promise<unknown>
    ) => {
      handlers.set(method, handler)
    }
  } as unknown as RelayDispatcher
  new GlabExecHandler(dispatcher)
  return { get: (method) => handlers.get(method) }
}

describe('GlabExecHandler', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('spawns exactly glab with argv array (no shell)', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      args: ['auth', 'status', '--hostname', 'gitlab.com'],
      cwd: '/home/user/repo',
      timeoutMs: 5_000
    })

    child.stdout.emit('data', Buffer.from('{"ok":true}'))
    child.emit('close', 0)

    await expect(pending).resolves.toEqual({
      stdout: '{"ok":true}',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status', '--hostname', 'gitlab.com'],
      expect.objectContaining({
        cwd: '/home/user/repo',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    )
  })

  it('does not let caller env redirect glab executable resolution', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()
    vi.stubEnv('PATH', '/relay-safe-bin')
    vi.stubEnv('Path', 'C:\\relay-safe-bin')

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      args: ['api', 'user'],
      env: {
        PATH: '/tmp/attacker-bin',
        Path: 'C:\\attacker-bin',
        PATHEXT: '.ATTACK',
        GITLAB_HOST: 'gitlab.example.com:8443',
        gitlab_token: 'gitlab-token',
        GLAB_TOKEN: 'glab-token',
        OTHER: 'ignored'
      }
    })
    child.emit('close', 0)
    await pending

    const spawnOptions = spawnMock.mock.calls[0][2] as { env: Record<string, string> }
    const pathValues = Object.entries(spawnOptions.env)
      .filter(([key]) => key.toLowerCase() === 'path')
      .map(([, value]) => value)
    expect(pathValues).toEqual(expect.arrayContaining(['/relay-safe-bin', 'C:\\relay-safe-bin']))
    expect(pathValues).not.toContain('/tmp/attacker-bin')
    expect(pathValues).not.toContain('C:\\attacker-bin')
    expect(spawnOptions.env.PATHEXT).not.toBe('.ATTACK')
    expect(spawnOptions.env.GITLAB_HOST).toBe('gitlab.example.com:8443')
    expect(spawnOptions.env.GITLAB_TOKEN).toBe('gitlab-token')
    expect(spawnOptions.env.GLAB_TOKEN).toBe('glab-token')
    expect(spawnOptions.env.OTHER).toBeUndefined()
  })

  it('never accepts a caller-supplied binary', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      binary: '/tmp/evil',
      args: ['version']
    })
    child.emit('close', 0)
    await pending

    expect(spawnMock).toHaveBeenCalledWith('glab', ['version'], expect.any(Object))
  })

  it('reports spawn errors without throwing', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn glab ENOENT')
    })
    const handlers = createHandler()

    await expect(handlers.get(GLAB_EXEC_METHOD)!({ args: ['version'] })).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: expect.stringContaining('ENOENT')
    })
  })

  it('finishes immediately with outputLimitExceeded when stdout exceeds 4 MiB', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      args: ['api', 'projects'],
      timeoutMs: 30_000
    })

    // Under limit first so partial stdout is retained, then overflow.
    child.stdout.emit('data', Buffer.from('partial-ok'))
    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 0x61))

    await expect(pending).resolves.toEqual({
      stdout: 'partial-ok',
      stderr: '',
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: 'stdout'
    })
    expect(child.kill).toHaveBeenCalled()

    // Late close must not overwrite the limit result (finish is settled).
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({ outputLimitExceeded: 'stdout' })
  })

  it('preserves a multibyte UTF-8 character split across stream chunks', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      args: ['api', 'user'],
      timeoutMs: 5_000
    })

    // € is three bytes (0xE2 0x82 0xAC) — emit split across two data events.
    const euro = Buffer.from('€', 'utf8')
    child.stdout.emit('data', euro.subarray(0, 2))
    child.stdout.emit('data', euro.subarray(2))
    child.emit('close', 0)

    await expect(pending).resolves.toEqual({
      stdout: '€',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
  })

  it('finishes immediately with outputLimitExceeded when stderr exceeds 4 MiB', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      args: ['mr', 'list'],
      timeoutMs: 30_000
    })

    child.stderr.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 0x62))

    await expect(pending).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: 'stderr'
    })
    expect(child.kill).toHaveBeenCalled()
  })

  it('does not spawn glab when the request is already aborted', async () => {
    const handlers = createHandler()
    const controller = new AbortController()
    controller.abort()

    const pending = handlers.get(GLAB_EXEC_METHOD)!(
      { args: ['version'], timeoutMs: 5_000 },
      { signal: controller.signal }
    )

    expect(spawnMock).not.toHaveBeenCalled()
    await expect(pending).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false
    })
  })

  it('terminates glab when the request is aborted after spawn', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()
    const controller = new AbortController()

    const pending = handlers.get(GLAB_EXEC_METHOD)!(
      { args: ['version'], timeoutMs: 5_000 },
      { signal: controller.signal }
    )

    expect(child.kill).not.toHaveBeenCalled()
    controller.abort()
    expect(child.kill).toHaveBeenCalled()
    // Why: kill is best-effort; the handler settles only on child close.
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({
      exitCode: null,
      timedOut: false
    })
  })
})
