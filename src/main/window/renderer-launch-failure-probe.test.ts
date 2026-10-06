import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { withPlatform } from './createMainWindow-test-harness'

import {
  classifyLaunchProbeError,
  probeRendererLaunchCapacity,
  recordRendererLaunchFailureProbe
} from './renderer-launch-failure-probe'

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn /bin/sh ${code}`), { code, errno: -35, syscall: 'spawn' })
}

function recordPosixFailure(now: number) {
  return withPlatform('darwin', () => recordRendererLaunchFailureProbe({ exitCode: 1003 }, now))
}

describe('classifyLaunchProbeError', () => {
  it.each(['EAGAIN', 'EACCES', 'ENOENT', 'EMFILE'])('reports the spawn errno %s', (code) => {
    expect(classifyLaunchProbeError(spawnError(code))).toBe(code)
  })

  it.each([
    ['a plain error', new Error('boom')],
    ['a non-errno code', Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })],
    ['a numeric code', Object.assign(new Error('x'), { code: 11 })],
    ['a non-error throw', 'EAGAIN']
  ])('reports unknown for %s', (_label, error) => {
    expect(classifyLaunchProbeError(error)).toBe('unknown')
  })
})

describe('probeRendererLaunchCapacity', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    recordDurableCrashBreadcrumbMock.mockReset()
  })

  it('reports ok for any child that started, whatever its exit', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await expect(probeRendererLaunchCapacity('darwin')).resolves.toBe('ok')
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/bin/sh', args: ['-c', 'exit 0'] })
    )
  })

  // Windows EDR scores a short-lived child per operation; the breadcrumb still records the launch failure.
  it('skips the spawn on Windows', async () => {
    await expect(probeRendererLaunchCapacity('win32')).resolves.toBe('skipped')
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('records a skipped Windows probe without spawning a child', async () => {
    await expect(
      withPlatform('win32', () => recordRendererLaunchFailureProbe({ exitCode: 18 }, 100_000))
    ).resolves.toBe('skipped')
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_launch_failed_probe', {
      spawnError: 'skipped',
      exitCode: 18
    })
  })

  it('never rejects when the breadcrumb write throws', async () => {
    runProcessMock.mockRejectedValue(spawnError('EAGAIN'))
    recordDurableCrashBreadcrumbMock.mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(recordPosixFailure(90_000)).resolves.toBe('EAGAIN')
  })

  it('records the refused spawn as a durable breadcrumb', async () => {
    runProcessMock.mockRejectedValue(spawnError('EAGAIN'))
    await expect(recordPosixFailure(10_000)).resolves.toBe('EAGAIN')
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_launch_failed_probe', {
      spawnError: 'EAGAIN',
      exitCode: 1003
    })
  })

  it('probes once for the duplicate render-process-gone of one failed launch', async () => {
    runProcessMock.mockRejectedValue(spawnError('EAGAIN'))
    await recordPosixFailure(50_000)
    await recordPosixFailure(50_010)
    expect(runProcessMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledOnce()

    // The next backoff retry fails again: a fresh probe and breadcrumb.
    await recordPosixFailure(50_250)
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledTimes(2)
  })
})
