import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { GLAB_EXEC_METHOD } from '../../shared/ssh-types'
import {
  clearGlabSshCapabilityStateForTests,
  setGlabSshExecutionDepsForTests,
  tryGlabOnSshHost
} from './glab-ssh-execution'

describe('tryGlabOnSshHost', () => {
  const requestA = vi.fn()
  const requestB = vi.fn()
  const muxA = { request: requestA }
  const muxB = { request: requestB }
  const targets = new Map<string, { runGitLabCliOnHost?: boolean }>()

  beforeEach(() => {
    clearGlabSshCapabilityStateForTests()
    requestA.mockReset()
    requestB.mockReset()
    targets.clear()
    setGlabSshExecutionDepsForTests({
      getTarget: (id) => targets.get(id),
      getMux: (id) => {
        if (id === 'host-a') {
          return muxA
        }
        if (id === 'host-b') {
          return muxB
        }
        return undefined
      }
    })
  })

  afterEach(() => {
    setGlabSshExecutionDepsForTests(null)
    clearGlabSshCapabilityStateForTests()
  })

  it('returns null when the target flag is off (no relay request)', async () => {
    targets.set('host-a', { runGitLabCliOnHost: false })
    await expect(
      tryGlabOnSshHost(['mr', 'list'], { sshTargetId: 'host-a', remoteCwd: '/repo' })
    ).resolves.toBeNull()
    expect(requestA).not.toHaveBeenCalled()
  })

  it('returns null when the target is missing or disconnected', async () => {
    await expect(
      tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'missing' })
    ).resolves.toBeNull()

    targets.set('host-a', { runGitLabCliOnHost: true })
    setGlabSshExecutionDepsForTests({
      getTarget: (id) => targets.get(id),
      getMux: () => undefined
    })
    await expect(
      tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-a' })
    ).resolves.toBeNull()
  })

  it('routes glab through the relay when flag is on and connected', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    requestA.mockResolvedValueOnce({
      stdout: '{"iid":1}',
      stderr: '',
      exitCode: 0
    })

    await expect(
      tryGlabOnSshHost(['mr', 'view', '1', '--output', 'json'], {
        sshTargetId: 'host-a',
        remoteCwd: '/home/user/repo',
        timeout: 12_000,
        env: { GITLAB_HOST: 'gitlab.example.com' }
      })
    ).resolves.toEqual({ stdout: '{"iid":1}', stderr: '' })

    expect(requestA).toHaveBeenCalledWith(
      GLAB_EXEC_METHOD,
      {
        args: ['mr', 'view', '1', '--output', 'json'],
        cwd: '/home/user/repo',
        timeoutMs: 12_000,
        env: { GITLAB_HOST: 'gitlab.example.com' }
      },
      undefined
    )
  })

  it('forwards AbortSignal to the mux request so callers can cancel remote glab', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    const controller = new AbortController()
    requestA.mockResolvedValueOnce({ stdout: 'ok', stderr: '', exitCode: 0 })

    await expect(
      tryGlabOnSshHost(['auth', 'status'], {
        sshTargetId: 'host-a',
        signal: controller.signal
      })
    ).resolves.toEqual({ stdout: 'ok', stderr: '' })

    expect(requestA).toHaveBeenCalledWith(
      GLAB_EXEC_METHOD,
      { args: ['auth', 'status'] },
      { signal: controller.signal }
    )
  })

  it('falls back to local and caches method-not-found per mux (no repeated probes)', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    const methodNotFound = Object.assign(new Error('Method not found: glab.exec'), {
      code: JsonRpcErrorCode.MethodNotFound
    })
    requestA.mockRejectedValue(methodNotFound)

    await expect(
      tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-a' })
    ).resolves.toBeNull()
    await expect(tryGlabOnSshHost(['mr', 'list'], { sshTargetId: 'host-a' })).resolves.toBeNull()

    expect(requestA).toHaveBeenCalledTimes(1)
  })

  it('isolates capability state across SSH targets', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    targets.set('host-b', { runGitLabCliOnHost: true })
    const methodNotFound = Object.assign(new Error('Method not found: glab.exec'), {
      code: JsonRpcErrorCode.MethodNotFound
    })
    requestA.mockRejectedValue(methodNotFound)
    requestB.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })

    await expect(
      tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-a' })
    ).resolves.toBeNull()
    await expect(tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-b' })).resolves.toEqual({
      stdout: 'ok',
      stderr: ''
    })

    expect(requestA).toHaveBeenCalledTimes(1)
    expect(requestB).toHaveBeenCalledTimes(1)
  })

  it('uses a fresh capability probe after reconnect (new mux object)', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    const methodNotFound = Object.assign(new Error('Method not found: glab.exec'), {
      code: JsonRpcErrorCode.MethodNotFound
    })
    requestA.mockRejectedValueOnce(methodNotFound)

    await expect(
      tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-a' })
    ).resolves.toBeNull()
    expect(requestA).toHaveBeenCalledTimes(1)

    const requestA2 = vi.fn().mockResolvedValue({ stdout: 'fresh', stderr: '', exitCode: 0 })
    const muxA2 = { request: requestA2 }
    setGlabSshExecutionDepsForTests({
      getTarget: (id) => targets.get(id),
      getMux: (id) => (id === 'host-a' ? muxA2 : undefined)
    })

    await expect(tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-a' })).resolves.toEqual({
      stdout: 'fresh',
      stderr: ''
    })
    expect(requestA2).toHaveBeenCalledTimes(1)
  })

  it('shares concurrent first probes and does not double-request', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    let resolveRequest!: (value: unknown) => void
    requestA.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        })
    )

    const first = tryGlabOnSshHost(['auth', 'status'], { sshTargetId: 'host-a' })
    const second = tryGlabOnSshHost(['mr', 'list'], { sshTargetId: 'host-a' })
    // Why: both waiters share the in-flight probe; only the probe issues the first request.
    await Promise.resolve()
    expect(requestA).toHaveBeenCalledTimes(1)

    resolveRequest({ stdout: 'p1', stderr: '', exitCode: 0 })
    // After probe succeeds, the waiter re-runs its own preferred command.
    requestA.mockResolvedValueOnce({ stdout: 'p2', stderr: '', exitCode: 0 })

    await expect(first).resolves.toEqual({ stdout: 'p1', stderr: '' })
    await expect(second).resolves.toEqual({ stdout: 'p2', stderr: '' })
  })

  it('surfaces remote glab failures without local fallback', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    requestA.mockResolvedValueOnce({
      stdout: '',
      stderr: 'HTTP 401 Unauthorized',
      exitCode: 1
    })

    await expect(tryGlabOnSshHost(['api', 'user'], { sshTargetId: 'host-a' })).rejects.toThrow(
      /401/
    )
    expect(requestA).toHaveBeenCalledTimes(1)
  })

  it('surfaces outputLimitExceeded as a diagnosable error (not code unknown)', async () => {
    targets.set('host-a', { runGitLabCliOnHost: true })
    requestA.mockResolvedValueOnce({
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: 'stdout'
    })

    await expect(
      tryGlabOnSshHost(['api', 'projects'], { sshTargetId: 'host-a', remoteCwd: '/repo' })
    ).rejects.toThrow('glab stdout exceeded capture limit on SSH host')
  })

})
