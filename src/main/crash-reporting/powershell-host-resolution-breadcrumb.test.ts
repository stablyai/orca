import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCrashReportDetails } from '../../shared/crash-report-redaction'
import type { WindowsPowerShellHostResolution } from '../../shared/windows-powershell-host'

const mocks = vi.hoisted(() => ({ observer: vi.fn(), record: vi.fn() }))
vi.mock('../../shared/windows-powershell-host', () => ({
  setWindowsPowerShellHostResolutionObserver: mocks.observer,
  warmWindowsPowerShellHostCache: vi.fn()
}))
vi.mock('./durable-crash-breadcrumb', () => ({ recordDurableCrashBreadcrumb: mocks.record }))

import { registerPowerShellHostResolutionBreadcrumb } from './powershell-host-resolution-breadcrumb'

afterEach(() => vi.restoreAllMocks())

describe('PowerShell host diagnostics', () => {
  it('distinguishes all candidates from attempts and preserves host identity after redaction', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    registerPowerShellHostResolutionBreadcrumb()
    const observer = mocks.observer.mock.calls.at(-1)![0] as (
      resolution: WindowsPowerShellHostResolution
    ) => void
    const host = 'C:\\Users\\private-name\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    observer({
      host,
      candidates: [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        host,
        'C:\\Windows\\powershell.exe'
      ],
      fellBack: false,
      attempts: [
        {
          path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          absent: true,
          ok: false,
          durationMs: 0
        },
        { path: host, ok: true, exitCode: 7, markerOk: true, durationMs: 6620 }
      ]
    })
    const data = sanitizeCrashReportDetails(mocks.record.mock.calls.at(-1)![1])
    expect(data).toMatchObject({
      host: '[redacted-path]',
      hostName: 'pwsh.exe',
      selectedIndex: 1,
      candidateCount: 3,
      probedCount: 1,
      skippedCount: 1,
      untriedCount: 1
    })
    expect(data.attempt0).toContain('absent=true')
    expect(data.attempt1).toContain('#1 pwsh.exe absent=false ok=true exit=7 marker=true')
    expect(JSON.stringify(data)).not.toContain('private-name')
  })
})
