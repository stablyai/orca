import { describe, expect, it } from 'vitest'
import { clientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'
import { isTerminalForegroundInspectionUnavailable } from './terminal-foreground-status-unavailable'

describe('isTerminalForegroundInspectionUnavailable', () => {
  it('treats the legacy unavailable host shape as unread membership', () => {
    expect(
      isTerminalForegroundInspectionUnavailable({
        foregroundProcess: null,
        hasChildProcesses: true,
        unavailable: true
      })
    ).toBe(true)
  })

  it('treats current pre-v11 unverifiable inspect as unread membership', () => {
    expect(
      isTerminalForegroundInspectionUnavailable(clientOnlyUnverifiableInspection('old_host'))
    ).toBe(true)
  })

  it('does not treat a confirmed empty foreground as unavailable', () => {
    expect(
      isTerminalForegroundInspectionUnavailable({
        foregroundProcess: null,
        hasChildProcesses: false
      })
    ).toBe(false)
  })
})
