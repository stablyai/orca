import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('./crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'

beforeEach(() => {
  recordDurableCrashBreadcrumbMock.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('recordUpdaterLifecycle', () => {
  it('records updater events in the durable lifecycle trace', () => {
    recordUpdaterLifecycle('quit_and_install', { version: '1.2.3' })

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('updater_quit_and_install', {
      version: '1.2.3'
    })
  })
})
