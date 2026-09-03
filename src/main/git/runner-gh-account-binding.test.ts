import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  spawnMock,
  resolveGhAccountTokenMock,
  buildBoundGhChildEnvMock,
  createGhBoundAccountHostMismatchErrorMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveGhAccountTokenMock: vi.fn(),
  buildBoundGhChildEnvMock: vi.fn(),
  createGhBoundAccountHostMismatchErrorMock: vi.fn(
    (binding: { host: string; user: string }, host?: string) =>
      Object.assign(
        new Error(
          host
            ? `host mismatch ${binding.host} vs ${host}`
            : `host required for ${binding.user}@${binding.host}`
        ),
        { code: 'gh_bound_account_host_mismatch', stderr: 'host mismatch' }
      )
  )
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))

import type * as GhAccountTokenModule from '../github/gh-account-token'

vi.mock('../github/gh-account-token', async (importOriginal) => {
  const actual = await importOriginal<typeof GhAccountTokenModule>()
  return {
    ...actual,
    resolveGhAccountToken: resolveGhAccountTokenMock,
    buildBoundGhChildEnv: buildBoundGhChildEnvMock,
    createGhBoundAccountHostMismatchError: createGhBoundAccountHostMismatchErrorMock
  }
})

import { ghExecFileAsync } from './runner'
import { _resetGhRateLimitBreaker } from './gh-rate-limit-breaker'

function mockChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

/** Spawns a child that settles with `stdout`, capturing the env the runner handed it. */
function spawnSettledChild(stdout: string): {
  env: () => NodeJS.ProcessEnv | undefined
} {
  let capturedEnv: NodeJS.ProcessEnv | undefined
  spawnMock.mockImplementation(
    (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env
      const child = mockChild()
      queueMicrotask(() => {
        child.stdout?.emit('data', Buffer.from(stdout))
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      return child
    }
  )
  return { env: () => capturedEnv }
}

describe('ghExecFileAsync account binding', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    resolveGhAccountTokenMock.mockReset()
    buildBoundGhChildEnvMock.mockReset()
    createGhBoundAccountHostMismatchErrorMock.mockClear()
    _resetGhRateLimitBreaker()
    resolveGhAccountTokenMock.mockResolvedValue('bound-token')
    buildBoundGhChildEnvMock.mockImplementation(
      ({
        baseEnv,
        binding,
        token
      }: {
        baseEnv?: NodeJS.ProcessEnv
        binding: { host: string; user: string }
        token: string
      }) => ({
        ...(baseEnv ?? process.env),
        GH_PROMPT_DISABLED: '1',
        GH_TOKEN: binding.host === 'github.com' ? token : undefined,
        GH_ENTERPRISE_TOKEN: binding.host === 'github.com' ? undefined : token
      })
    )
  })

  afterEach(() => {
    _resetGhRateLimitBreaker()
  })

  it('injects bound token env for non-auth calls with matching host', async () => {
    const spawned = spawnSettledChild('[]')

    await ghExecFileAsync(['api', 'user'], {
      host: 'github.com',
      ghAccount: { host: 'github.com', user: 'Alice' },
      env: { ...process.env, GH_TOKEN: 'ambient' }
    })

    expect(resolveGhAccountTokenMock).toHaveBeenCalledWith(
      { host: 'github.com', user: 'Alice' },
      expect.any(Object)
    )
    expect(buildBoundGhChildEnvMock).toHaveBeenCalled()
    expect(spawned.env()?.GH_TOKEN).toBe('bound-token')
  })

  it('skips injection for auth probes', async () => {
    const spawned = spawnSettledChild('')

    await ghExecFileAsync(['auth', 'status'], {
      host: 'github.com',
      ghAccount: { host: 'github.com', user: 'Alice' },
      env: { ...process.env, GH_TOKEN: 'ambient' }
    })

    expect(resolveGhAccountTokenMock).not.toHaveBeenCalled()
    expect(spawned.env()?.GH_TOKEN).toBe('ambient')
  })

  it('pins options.host from the binding when callers omit host', async () => {
    const spawned = spawnSettledChild('[]')

    await ghExecFileAsync(['api', 'user'], {
      ghAccount: { host: 'github.com', user: 'Alice' }
    })

    expect(resolveGhAccountTokenMock).toHaveBeenCalled()
    expect(spawned.env()?.GH_TOKEN).toBe('bound-token')
  })

  it('fails closed when argv host signals disagree with the binding', async () => {
    await expect(
      ghExecFileAsync(['pr', 'list', '--repo', 'github.acme.com/a/b'], {
        host: 'github.com',
        ghAccount: { host: 'github.com', user: 'Alice' }
      })
    ).rejects.toMatchObject({ code: 'gh_bound_account_host_mismatch' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(['-Rgithub.acme.com/a/b', '-R=github.acme.com/a/b'])(
    'fails closed for the attached %s host form',
    async (attached) => {
      await expect(
        ghExecFileAsync(['pr', 'list', attached], {
          host: 'github.com',
          ghAccount: { host: 'github.com', user: 'Alice' }
        })
      ).rejects.toMatchObject({ code: 'gh_bound_account_host_mismatch' })
      expect(spawnMock).not.toHaveBeenCalled()
    }
  )

  it('accepts an attached -R form that names the bound host', async () => {
    const spawned = spawnSettledChild('[]')

    await ghExecFileAsync(['pr', 'list', '-Rgithub.com/a/b'], {
      host: 'github.com',
      ghAccount: { host: 'github.com', user: 'Alice' }
    })

    expect(spawned.env()?.GH_TOKEN).toBe('bound-token')
  })
})
