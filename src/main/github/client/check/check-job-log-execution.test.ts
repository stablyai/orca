import type { SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
import { snapshotCheckJobLogExecution } from './check-job-log-execution'
import { ghExecFileAsync } from '../../../git/command-runner/gh-exec-file'
import { createGhLogicalLifetime } from '../../../git/command-runner/gh-capture-lifetime'

const repo = { owner: 'acme', repo: 'widgets' }
const platform = process.platform

describe('effective check log execution snapshot', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    spawnMock.mockImplementation((_program: string, _argv: string[], options: SpawnOptions) => {
      const child = createFakeSpawnedChild()
      queueMicrotask(() =>
        completeFakeSpawn(child, {
          stdout:
            options.env?.GH_TOKEN ??
            options.env?.GITHUB_TOKEN ??
            options.env?.GH_ENTERPRISE_TOKEN ??
            options.env?.GITHUB_ENTERPRISE_TOKEN ??
            ''
        })
      )
      return child
    })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    vi.unstubAllEnvs()
  })

  it.each([
    ['github.com', { GH_TOKEN: 'primary' }],
    ['github.com', { GITHUB_TOKEN: 'secondary' }],
    ['github.localhost', { GH_TOKEN: '', GITHUB_TOKEN: 'secondary' }],
    ['code.acme.test', { GH_ENTERPRISE_TOKEN: 'primary' }],
    ['code.acme.test:8443', { GITHUB_ENTERPRISE_TOKEN: 'secondary' }],
    ['code.acme.test', { GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: 'secondary' }],
    ['github.com', { GH_TOKEN: ' ', GITHUB_TOKEN: 'secondary' }]
  ])('proves established credentials for %s', (host, env) => {
    expect(snapshotCheckJobLogExecution({ ...repo, host }, { env }).executionScope).toMatch(
      /^[a-f0-9]{64}$/
    )
  })
  it.each([
    'ghe.com',
    'tenant.ghe.com',
    'api.github.com',
    'a.github.localhost',
    'github.com:443',
    'github.localhost:443',
    'bad/host'
  ])('bypasses ambiguous host %s', (host) => {
    expect(
      snapshotCheckJobLogExecution(
        { ...repo, host },
        { ghAccount: { host, user: 'Alice' }, env: { GH_TOKEN: 'a', GH_ENTERPRISE_TOKEN: 'b' } }
      ).executionScope
    ).toBeNull()
  })
  it('bypasses keyring, host mismatch and invalid bindings', () => {
    expect(snapshotCheckJobLogExecution(repo, { env: {} }).executionScope).toBeNull()
    expect(() =>
      snapshotCheckJobLogExecution(repo, { host: 'other.test', env: { GH_TOKEN: 'a' } })
    ).toThrow('GitHub check details host is unavailable.')
    expect(
      snapshotCheckJobLogExecution(repo, {
        ghAccount: { host: 'github.com', user: '' },
        env: { GH_TOKEN: 'a' }
      }).executionScope
    ).toBeNull()
  })
  it('uses normalized binding and fixed projection order but exact login casing', () => {
    const a = snapshotCheckJobLogExecution(repo, {
      cwd: '/folder',
      ghAccount: { user: ' Alice ', host: ' GitHub.COM ' },
      env: {}
    })
    const b = snapshotCheckJobLogExecution(repo, {
      env: {},
      ghAccount: { host: 'github.com', user: 'Alice' },
      cwd: '/folder',
      encoding: 'utf-8'
    })
    const c = snapshotCheckJobLogExecution(repo, {
      env: {},
      ghAccount: { host: 'github.com', user: 'alice' },
      cwd: '/folder'
    })
    expect(a.executionScope).toBe(b.executionScope)
    expect(a.executionScope).not.toBe(c.executionScope)
  })
  it.each([undefined, 'C:\\folder', String.raw`\\wsl.localhost\Ubuntu\home\repo`])(
    'keeps Windows runtime proof conservative for %s',
    (cwd) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const scope = snapshotCheckJobLogExecution(repo, {
        cwd,
        env: { GH_TOKEN: 'a' }
      }).executionScope
      expect(scope === null).toBe(cwd !== 'C:\\folder')
      expect(
        snapshotCheckJobLogExecution(repo, { cwd, wslDistro: 'Ubuntu', env: { GH_TOKEN: 'a' } })
          .executionScope
      ).toBeNull()
    }
  )
  it('owns inherited and explicit environment before deferred actual API children', async () => {
    vi.stubEnv('GH_TOKEN', 'inherited-A')
    const inherited = snapshotCheckJobLogExecution(repo, {})
    const override = { GH_TOKEN: 'override-A', GH_PROMPT_DISABLED: '' }
    const explicit = snapshotCheckJobLogExecution(repo, { env: override })
    vi.stubEnv('GH_TOKEN', 'inherited-B')
    override.GH_TOKEN = 'override-B'
    const later = snapshotCheckJobLogExecution(repo, {})
    for (const [snapshot, expected] of [
      [inherited, 'inherited-A'],
      [explicit, 'override-A'],
      [later, 'inherited-B']
    ] as const) {
      const lifetime = createGhLogicalLifetime()
      const result = await ghExecFileAsync(
        ['api', 'repos/acme/widgets/actions/jobs/1/logs'],
        snapshot.ghOptions,
        lifetime.hooks
      )
      lifetime.seal()
      await lifetime.terminated
      expect(result.stdout).toBe(expected)
    }
    expect(inherited.executionScope).not.toBe(later.executionScope)
    expect(spawnMock.mock.calls[1][2].env.GH_PROMPT_DISABLED).toBe('')
    expect(spawnMock.mock.calls[0][1]).toContain('github.com')
    expect(snapshotCheckJobLogExecution(repo, { env: {} }).ghOptions.env).toEqual({
      GH_PROMPT_DISABLED: '1'
    })
  })
  it('changes digest for secondary or ignored variable changes without reading later mutation', () => {
    const a = snapshotCheckJobLogExecution(repo, {
      env: { GH_ENTERPRISE_TOKEN: 'ignored', GITHUB_TOKEN: 'a' }
    })
    const b = snapshotCheckJobLogExecution(repo, {
      env: { GH_ENTERPRISE_TOKEN: 'ignored', GITHUB_TOKEN: 'b' }
    })
    const c = snapshotCheckJobLogExecution(repo, {
      env: { GH_ENTERPRISE_TOKEN: 'other', GITHUB_TOKEN: 'a' }
    })
    expect(a.executionScope).not.toBe(b.executionScope)
    expect(a.executionScope).not.toBe(c.executionScope)
  })
})
