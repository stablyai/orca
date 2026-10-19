import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type * as ProcessHostModule from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import type { GhExecOptions } from '../../../git/command-runner/gh-exec-file'
import { clearGhAccountTokenCacheForTests } from '../../gh-account-token'
import { clearGhCapabilityStateForTests } from '../../gh-capability-state'
import { getPRCheckDetails } from './get-pr-check-details'
import { prCheckLogTailCache } from './check-job-log-tails'

const { spawnMock, resolverMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolverMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('../../github-api-repository', () => ({ resolveGitHubRepoExecution: resolverMock }))
vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof ProcessHostModule>()
  return {
    ...actual,
    runProcess: (spec: Parameters<typeof actual.runProcess>[0]) => {
      if (!spec.args) {
        throw new Error('Expected check details capture arguments')
      }
      captures.push({ spec: { ...spec, args: spec.args }, startedAt: Date.now() })
      return actual.runProcess(spec)
    }
  }
})
const children: ChildProcess[] = []
const captures: {
  spec: Parameters<typeof ProcessHostModule.runProcess>[0] & { args: readonly string[] }
  startedAt: number
}[] = []
const repo = { owner: 'acme', repo: 'widgets', host: 'github.com' }

describe('full check details snapshot before admission', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    captures.length = 0
    clearGhAccountTokenCacheForTests()
    clearGhCapabilityStateForTests()
    prCheckLogTailCache.clear()
    resolverMock.mockReset().mockResolvedValue({ ownerRepo: repo, ghOptions: { env: {} } })
    spawnMock.mockReset().mockImplementation(() => {
      const child = createFakeSpawnedChild(children.length + 800)
      children.push(child)
      return child
    })
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.unstubAllEnvs()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses queued A for metadata and both parser children, isolates B, and warms only restored A', async () => {
    const blockers = Array.from({ length: 4 }, (_, i) =>
      getPRCheckDetails('/folder', { checkRunId: 900 + i }).catch((error: unknown) => error)
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(4)
    vi.stubEnv('GH_TOKEN', 'ambient-A')
    vi.stubEnv('ADMISSION_AMBIENT', 'ambient-A')
    const env = { SNAPSHOT_TEST: 'env-A', GITHUB_TOKEN: 'override-A', GH_PROMPT_DISABLED: '' }
    const binding = { host: ' GitHub.COM ', user: ' Alice ' }
    const options: GhExecOptions = {
      cwd: '/folder-A',
      encoding: 'utf-8',
      host: ' GitHub.COM ',
      ghAccount: binding,
      env,
      timeout: 17_000,
      idempotent: false
    }
    resolverMock.mockResolvedValue({ ownerRepo: repo, ghOptions: options })
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const deadlineAt = Date.now() + 25_000
    const args = { checkRunId: 1, workflowRunId: 2 }
    const queued = getPRCheckDetails('/folder', args, undefined, {}, controller.signal)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(resolverMock).toHaveBeenCalledTimes(5)
    expect(children).toHaveLength(4)
    env.SNAPSHOT_TEST = 'env-B'
    env.GITHUB_TOKEN = 'override-B'
    env.GH_PROMPT_DISABLED = 'B'
    binding.host = 'github.com'
    binding.user = 'Bob'
    options.cwd = '/folder-B'
    options.timeout = 9_000
    vi.stubEnv('GH_TOKEN', 'ambient-B')
    vi.stubEnv('ADMISSION_AMBIENT', 'ambient-B')
    spawnMock.mockImplementation((_program: string, argv: string[], spawnOptions: SpawnOptions) => {
      const child = createFakeSpawnedChild(children.length + 800)
      children.push(child)
      const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
      if (argv.includes('--help')) {
        queueMicrotask(() => completeFakeSpawn(child, { stdout: '--user' }))
      } else if (argv[0] === 'auth') {
        const user = argv[argv.indexOf('--user') + 1]
        queueMicrotask(() => completeFakeSpawn(child, { stdout: `token-${user}` }))
      } else if (endpoint.endsWith('/logs') && argv.includes('--allow-escape-sequences')) {
        setTimeout(
          () =>
            completeFakeSpawn(child, {
              code: 1,
              stderr: 'unknown flag: --allow-escape-sequences\n'
            }),
          1_000
        )
      } else {
        const stdout = endpoint.endsWith('/logs')
          ? `Error: ${spawnOptions.env?.SNAPSHOT_TEST}`
          : endpoint.includes('/annotations')
            ? '[]'
            : endpoint.includes('/jobs?')
              ? JSON.stringify({
                  jobs: [
                    {
                      id: 77,
                      name: 'job',
                      status: 'completed',
                      conclusion: 'failure',
                      completed_at: 'done'
                    }
                  ]
                })
              : '{"name":"retained","output":{"summary":"kept"}}'
        queueMicrotask(() => completeFakeSpawn(child, { stdout }))
      }
      return child
    })
    // A positive close lets the first blocker finish and release its actual permit.
    completeFakeSpawn(children[0], { stdout: '{"name":"blocker"}' })
    await vi.advanceTimersByTimeAsync(0)
    expect(
      captures.filter(({ spec }) => spec.args.some((arg) => arg.endsWith('/logs')))
    ).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(queued).resolves.toMatchObject({
      jobs: [{ logTail: 'Error: env-A', logState: 'available' }]
    })
    await blockers[0]
    const apiA = captures.filter(({ spec }) => spec.env?.SNAPSHOT_TEST === 'env-A')
    expect(apiA).toHaveLength(5)
    for (const { spec } of apiA) {
      expect(spec.program).toBe('gh')
      expect(spec.cwd).toBe('/folder-A')
      expect(spec.args[spec.args.indexOf('--hostname') + 1]).toBe('github.com')
      expect(spec.env).toMatchObject({
        GH_TOKEN: 'token-Alice',
        SNAPSHOT_TEST: 'env-A',
        GH_PROMPT_DISABLED: ''
      })
      expect(spec.env?.GITHUB_TOKEN).toBeUndefined()
      expect(spec.env?.ADMISSION_AMBIENT).toBeUndefined()
    }
    const metadataA = apiA.filter(({ spec }) => !spec.args.some((arg) => arg.endsWith('/logs')))
    expect(metadataA.map(({ spec }) => spec.timeoutMs)).toEqual([17_000, 17_000, 17_000])
    expect(metadataA.every(({ spec }) => spec.signal === metadataA[0].spec.signal)).toBe(true)
    const logsA = apiA.filter(({ spec }) => spec.args.some((arg) => arg.endsWith('/logs')))
    expect(logsA.map(({ spec }) => spec.args.includes('--allow-escape-sequences'))).toEqual([
      true,
      false
    ])
    expect(logsA.map(({ spec, startedAt }) => startedAt + Number(spec.timeoutMs))).toEqual([
      deadlineAt,
      deadlineAt
    ])
    expect(logsA.map(({ spec }) => spec.maxOutputBytes)).toEqual([
      64 * 1024 * 1024,
      64 * 1024 * 1024
    ])
    expect(logsA[0].spec.signal).toBe(logsA[1].spec.signal)
    expect(prCheckLogTailCache.size).toBe(1)
    expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1)
    expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1)

    const nextB = getPRCheckDetails('/folder', args)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(nextB).resolves.toMatchObject({ jobs: [{ logTail: 'Error: env-B' }] })
    const apiB = captures.filter(({ spec }) => spec.env?.SNAPSHOT_TEST === 'env-B')
    expect(apiB).toHaveLength(5)
    for (const { spec } of apiB) {
      expect(spec.cwd).toBe('/folder-B')
      expect(spec.env?.GH_TOKEN).toBe('token-Bob')
      expect(spec.env?.GH_PROMPT_DISABLED).toBe('B')
    }
    expect(prCheckLogTailCache.size).toBe(2)
    const keys = [...prCheckLogTailCache.keys()]
    expect(new Set(keys).size).toBe(2)
    env.SNAPSHOT_TEST = 'env-A'
    env.GITHUB_TOKEN = 'override-A'
    env.GH_PROMPT_DISABLED = ''
    binding.host = ' GitHub.COM '
    binding.user = ' Alice '
    options.cwd = '/folder-A'
    options.timeout = 17_000
    vi.stubEnv('GH_TOKEN', 'ambient-A')
    vi.stubEnv('ADMISSION_AMBIENT', 'ambient-A')
    const warmA = getPRCheckDetails('/folder', args)
    await vi.advanceTimersByTimeAsync(0)
    await expect(warmA).resolves.toMatchObject({ jobs: [{ logTail: 'Error: env-A' }] })
    expect(
      captures.filter(({ spec }) => spec.args.some((arg) => arg.endsWith('/logs')))
    ).toHaveLength(4)
    expect([...prCheckLogTailCache.keys()]).toEqual(keys)
    for (const child of children.slice(1, 4)) {
      completeFakeSpawn(child, { stdout: '{"name":"blocker"}' })
    }
    await vi.advanceTimersByTimeAsync(0)
    for (const result of await Promise.all(blockers)) {
      expect(result).toMatchObject({ name: 'blocker' })
    }
  })
})
