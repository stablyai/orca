import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('collectWindowsEventDiagnosticSummary', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('skips the event-log probe outside Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const { collectWindowsEventDiagnosticSummary } =
      await import('./windows-event-diagnostic-summary')

    await expect(collectWindowsEventDiagnosticSummary(30)).resolves.toEqual({
      supported: false,
      reason: 'not_windows'
    })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('treats empty event output as a successful empty summary', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    execFileAsyncMock.mockResolvedValue({ stdout: '[]', stderr: '' })
    const { collectWindowsEventDiagnosticSummary } =
      await import('./windows-event-diagnostic-summary')

    await expect(collectWindowsEventDiagnosticSummary(30)).resolves.toEqual({
      supported: true,
      count: 0,
      events: []
    })

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        expect.stringContaining(
          "$_.FullyQualifiedErrorId -eq 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand'"
        )
      ]),
      expect.objectContaining({ timeout: 5000, maxBuffer: 1024 * 1024 })
    )
  })
})
