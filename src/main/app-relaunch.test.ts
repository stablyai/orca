import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appRelaunchMock, recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { relaunch: appRelaunchMock } }))
vi.mock('./crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { relaunchApp } from './app-relaunch'

beforeEach(() => {
  appRelaunchMock.mockReset()
  recordDurableCrashBreadcrumbMock.mockReset()
})

describe('relaunchApp', () => {
  it('durably records the reason before scheduling the replacement process', () => {
    relaunchApp('gpu-fallback', { processReason: 'crashed', exitCode: 5 })

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('app_relaunch_requested', {
      processReason: 'crashed',
      exitCode: 5,
      reason: 'gpu-fallback'
    })
    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock.mock.invocationCallOrder[0]).toBeLessThan(
      appRelaunchMock.mock.invocationCallOrder[0]
    )
  })
})
