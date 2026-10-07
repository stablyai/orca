import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DaemonProcessStartTime from '../daemon/daemon-process-start-time'

const { readWindowsProcessCreationTime, getProcessStartedAtMs } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>(),
  getProcessStartedAtMs: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../windows/windows-process-table', () => ({ readWindowsProcessCreationTime }))
vi.mock('../daemon/daemon-process-start-time', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonProcessStartTime>()),
  getProcessStartedAtMs
}))

import {
  orcadProcessStartTimeMatches,
  readOrcadProcessStartedAtMs
} from './orcad-process-start-time'

const platform = process.platform
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  onPlatform(platform)
  vi.resetAllMocks()
})

describe('orcad process start time', () => {
  it('reads the addon creation time on Windows, never the POSIX probe', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(1_700_000_000_123)
    expect(readOrcadProcessStartedAtMs(42)).toBe(1_700_000_000_123)
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(42)
    expect(getProcessStartedAtMs).not.toHaveBeenCalled()
  })

  it('keeps the POSIX probe elsewhere', () => {
    onPlatform('linux')
    getProcessStartedAtMs.mockReturnValue(5_000)
    expect(readOrcadProcessStartedAtMs(42)).toBe(5_000)
    expect(readWindowsProcessCreationTime).not.toHaveBeenCalled()
  })

  it('tells a reused Windows PID apart, and fails open when the addon cannot answer', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(9_000_000)
    expect(orcadProcessStartTimeMatches(42, 1_000)).toBe(false)
    expect(orcadProcessStartTimeMatches(42, 9_000_100)).toBe(true)
    readWindowsProcessCreationTime.mockReturnValue(null)
    expect(orcadProcessStartTimeMatches(42, 1_000)).toBe(true)
  })
})
