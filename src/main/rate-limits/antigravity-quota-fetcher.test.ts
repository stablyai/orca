import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  resolveAntigravityCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'
import { fetchAntigravityRateLimits } from './antigravity-quota-fetcher'

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn()
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveAntigravityCommand: vi.fn(),
  withCliRuntimeOnPath: vi.fn((_command: string, env: NodeJS.ProcessEnv) => env)
}))

vi.mock('./hidden-rate-limit-pty-cwd', () => ({
  resolveHiddenRateLimitPtyCwd: vi.fn(() => '/tmp/orca-rate-limit')
}))

// Why: the not-installed guard keys on isAbsolute, so the fake must be absolute on every platform.
const FAKE_AGY = resolve('agy')

const QUOTA_STDOUT = [
  'Gemini Models\tWeekly Limit Remaining\t98%\t2026-09-23T09:08:07Z',
  'Gemini Models\tFive Hour Limit Remaining\t87%\t2026-09-16T14:08:07Z'
].join('\n')

function processResult(overrides: Partial<Awaited<ReturnType<typeof runProcess>>> = {}) {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveAntigravityCommand).mockReturnValue(FAKE_AGY)
    vi.mocked(runProcess).mockResolvedValue(processResult({ stdout: QUOTA_STDOUT }))
  })

  it('runs `agy --print /quota` and maps the rows into windows', async () => {
    const limits = await fetchAntigravityRateLimits()

    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: FAKE_AGY,
        args: ['--print', '/quota'],
        cwd: '/tmp/orca-rate-limit'
      })
    )
    expect(limits.status).toBe('ok')
    expect(limits.provider).toBe('antigravity')
    expect(limits.session?.usedPercent).toBe(13)
    expect(limits.buckets).toHaveLength(2)
  })

  it('skips the spawn when the CLI is not on PATH', async () => {
    vi.mocked(resolveAntigravityCommand).mockReturnValue('agy')

    const limits = await fetchAntigravityRateLimits()

    expect(runProcess).not.toHaveBeenCalled()
    expect(limits.status).toBe('unavailable')
    expect(limits.error).toBe('Antigravity CLI not found')
  })

  it('reports the CLI error detail on a non-zero exit', async () => {
    vi.mocked(runProcess).mockResolvedValue(
      processResult({ code: 1, stdout: '', stderr: 'You are currently not signed in.' })
    )

    const limits = await fetchAntigravityRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).toBe('Antigravity quota request failed: You are currently not signed in.')
  })

  it('errors when the output carries no quota rows', async () => {
    vi.mocked(runProcess).mockResolvedValue(processResult({ stdout: 'no quota here\n' }))

    const limits = await fetchAntigravityRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).toBe('Antigravity returned no quota data')
  })

  it('treats a missing binary rejection as unavailable', async () => {
    vi.mocked(runProcess).mockRejectedValue(
      Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' })
    )

    const limits = await fetchAntigravityRateLimits()

    expect(limits.status).toBe('unavailable')
    expect(limits.error).toBe('Antigravity CLI not found')
  })

  it.each(['EACCES', 'EPERM'])('keeps %s spawn failures as errors', async (code) => {
    vi.mocked(runProcess).mockRejectedValue(
      Object.assign(new Error('Cannot execute CLI'), { code })
    )
    expect(await fetchAntigravityRateLimits()).toMatchObject({
      status: 'error',
      error: 'Cannot execute CLI'
    })
  })

  it('does not classify an ENOENT string without an error code as a missing CLI', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('Unexpected ENOENT response'))
    expect((await fetchAntigravityRateLimits()).status).toBe('error')
  })

  it('contains a failure while preparing the hidden working directory', async () => {
    vi.mocked(resolveHiddenRateLimitPtyCwd).mockImplementationOnce(() => {
      throw new Error('Cannot prepare directory')
    })
    expect(await fetchAntigravityRateLimits()).toMatchObject({
      status: 'error',
      error: 'Cannot prepare directory'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('reports a timeout without parsing partial output', async () => {
    vi.mocked(runProcess).mockResolvedValue(processResult({ code: null, timedOut: true }))

    const limits = await fetchAntigravityRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).toBe('Antigravity quota request timed out')
  })

  it('returns an aborted result when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const limits = await fetchAntigravityRateLimits({ signal: controller.signal })

    expect(runProcess).not.toHaveBeenCalled()
    expect(limits.status).toBe('error')
    expect(limits.error).toBe('Antigravity quota request aborted')
  })

  it('passes the resolved command through the shared runtime-path helper', async () => {
    await fetchAntigravityRateLimits()

    expect(withCliRuntimeOnPath).toHaveBeenCalledWith(FAKE_AGY, expect.any(Object))
  })
})
