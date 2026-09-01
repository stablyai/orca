import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const { runProcessMock, resolveCliCommandMock, resolveRegisteredWorktreePathMock } = vi.hoisted(
  () => ({
    runProcessMock: vi.fn(),
    resolveCliCommandMock: vi.fn(),
    resolveRegisteredWorktreePathMock: vi.fn()
  })
)

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolveCliCommandMock
}))
vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: resolveRegisteredWorktreePathMock
}))

const { npmCliPackageView } = await import('./npm-cli-package-view')

const fakeStore = {} as Store

function processResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

describe('npmCliPackageView', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveRegisteredWorktreePathMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
    resolveRegisteredWorktreePathMock.mockResolvedValue('/repo/worktree')
  })

  it('resolves the npm binary before spawning, with the exact argv, cwd, env pins and timeout', async () => {
    runProcessMock.mockResolvedValue(
      processResult({ stdout: JSON.stringify({ name: 'react', version: '19.0.0' }) })
    )

    await npmCliPackageView('react', '/repo/worktree', fakeStore)

    expect(resolveCliCommandMock).toHaveBeenCalledWith('npm')
    expect(resolveRegisteredWorktreePathMock).toHaveBeenCalledWith('/repo/worktree', fakeStore)
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    const spec = runProcessMock.mock.calls[0]![0]
    expect(spec.program).toBe('/usr/local/bin/npm')
    expect(spec.args).toEqual(['view', 'react', '--json', '--silent'])
    expect(spec.cwd).toBe('/repo/worktree')
    expect(spec.timeoutMs).toBe(8000)
    expect(spec.env.COREPACK_ENABLE_AUTO_PIN).toBe('0')
    expect(spec.env.COREPACK_ENABLE_PROJECT_SPEC).toBe('0')
    // Resolution must happen before the spawn, not merely before returning.
    expect(resolveCliCommandMock.mock.invocationCallOrder[0]).toBeLessThan(
      runProcessMock.mock.invocationCallOrder[0]!
    )
  })

  it('returns ok with the parsed manifest fields on success', async () => {
    runProcessMock.mockResolvedValue(
      processResult({
        stdout: JSON.stringify({
          name: 'react',
          version: '19.0.0',
          description: 'React library',
          homepage: 'https://react.dev',
          repository: { type: 'git', url: 'git+https://github.com/facebook/react.git' }
        })
      })
    )

    const result = await npmCliPackageView('react', '/repo/worktree', fakeStore)

    expect(result).toEqual({
      status: 'ok',
      info: {
        packageName: 'react',
        description: 'React library',
        latestVersion: '19.0.0',
        latestPublishedAt: null,
        homepageUrl: 'https://react.dev/',
        repositoryUrl: 'https://github.com/facebook/react.git',
        source: 'npm-cli'
      }
    })
  })

  it('maps npm E404 to not-found', async () => {
    runProcessMock.mockResolvedValue(
      processResult({ code: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' })
    )

    const result = await npmCliPackageView('does-not-exist', '/repo/worktree', fakeStore)

    expect(result).toEqual({ status: 'not-found' })
  })

  it('maps every other non-zero exit to unavailable', async () => {
    runProcessMock.mockResolvedValue(processResult({ code: 1, stderr: 'network unreachable' }))

    const result = await npmCliPackageView('react', '/repo/worktree', fakeStore)

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
  })

  it('maps a timed-out probe to unavailable with reason timeout', async () => {
    runProcessMock.mockResolvedValue(processResult({ code: null, timedOut: true }))

    const result = await npmCliPackageView('react', '/repo/worktree', fakeStore)

    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' })
  })

  it('maps a rejected worktree cwd to unavailable with reason host-unresolved, without spawning', async () => {
    resolveRegisteredWorktreePathMock.mockRejectedValue(new Error('Access denied'))

    const result = await npmCliPackageView('react', '/not/registered', fakeStore)

    expect(result).toEqual({ status: 'unavailable', reason: 'host-unresolved' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('reports npm-unresolvable when spawning the resolved binary fails with ENOENT', async () => {
    const enoent = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
    runProcessMock.mockRejectedValue(enoent)

    const result = await npmCliPackageView('react', '/repo/worktree', fakeStore)

    expect(result).toEqual({ status: 'npm-unresolvable' })
  })

  it('maps a non-ENOENT spawn failure to unavailable with reason error', async () => {
    runProcessMock.mockRejectedValue(new Error('EACCES: permission denied'))

    const result = await npmCliPackageView('react', '/repo/worktree', fakeStore)

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
  })
})
