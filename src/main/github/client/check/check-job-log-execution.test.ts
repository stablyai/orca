import type { SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
import { snapshotCheckJobLogExecution } from './check-job-log-execution'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { createGhLogicalLifetime } from '../../../git/command-runner/hosted-cli/gh-capture-lifetime'

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
})
