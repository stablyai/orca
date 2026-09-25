import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isComputerSidecarDiagnostic,
  reportComputerDiagnostic
} from './computer-sidecar-diagnostics'

describe('computer sidecar diagnostics', () => {
  const originalSend = process.send

  afterEach(() => {
    process.send = originalSend
    vi.restoreAllMocks()
  })

  it('sends over IPC when running inside the sidecar', () => {
    const send = vi.fn((_message: unknown) => true)
    process.send = send as unknown as typeof process.send
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})

    reportComputerDiagnostic('fell back to Bypass')

    // The sidecar's stdout is piped and never read, so this must not go there.
    expect(console_).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({
      kind: 'computer-sidecar-diagnostic',
      message: 'fell back to Bypass'
    })
    expect(isComputerSidecarDiagnostic(send.mock.calls[0][0])).toBe(true)
  })

  it('logs directly when there is no IPC channel', () => {
    process.send = undefined
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})

    reportComputerDiagnostic('fell back to Bypass')

    expect(console_).toHaveBeenCalledWith('[computer-use] fell back to Bypass')
  })

  it('does not mistake a sidecar response for a diagnostic', () => {
    expect(isComputerSidecarDiagnostic({ id: 1, ok: true, result: {} })).toBe(false)
    expect(isComputerSidecarDiagnostic({ kind: 'computer-sidecar-diagnostic' })).toBe(false)
    expect(isComputerSidecarDiagnostic(null)).toBe(false)
  })
})
