import { describe, expect, it, vi } from 'vitest'
import {
  readTerminalAutoRestoreFitMs,
  saveTerminalAutoRestoreFitMs,
  setTerminalAutoRestoreFitMsForHost
} from './terminal-auto-restore-fit-state'

describe('terminal auto restore fit state', () => {
  it('reads host values after a read, a clamped save, and a refused save', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ id: '1', ok: true, result: { ms: 300_000 } })
      .mockResolvedValueOnce({ id: '2', ok: true, result: { ms: 5_000 } })
      .mockResolvedValueOnce({ id: '3', ok: false, error: { code: 'denied', message: 'Refused' } })
      .mockResolvedValueOnce({ id: '4', ok: true, result: { ms: 120_000 } })

    await expect(readTerminalAutoRestoreFitMs({ sendRequest })).resolves.toBe(300_000)
    await expect(saveTerminalAutoRestoreFitMs({ sendRequest }, 1_000)).resolves.toBe(5_000)
    await expect(saveTerminalAutoRestoreFitMs({ sendRequest }, 300_000)).resolves.toBe(120_000)
    expect(sendRequest.mock.calls).toEqual([
      ['terminal.getAutoRestoreFit'],
      ['terminal.setAutoRestoreFit', { ms: 1_000 }],
      ['terminal.setAutoRestoreFit', { ms: 300_000 }],
      ['terminal.getAutoRestoreFit']
    ])
  })

  it('reads a host without the setting as the default', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      id: '1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })

    await expect(readTerminalAutoRestoreFitMs({ sendRequest })).resolves.toBeNull()
    await expect(saveTerminalAutoRestoreFitMs({ sendRequest }, 60_000)).resolves.toBeNull()
  })

  it('returns the existing state object when a host value is unchanged', () => {
    const current = { hostA: 60_000, hostB: null }

    expect(setTerminalAutoRestoreFitMsForHost(current, 'hostA', 60_000)).toBe(current)
    expect(setTerminalAutoRestoreFitMsForHost(current, 'hostB', null)).toBe(current)
  })

  it('updates one host while preserving other host values', () => {
    const current = { hostA: 60_000, hostB: null }
    const next = setTerminalAutoRestoreFitMsForHost(current, 'hostA', 300_000)

    expect(next).not.toBe(current)
    expect(next).toEqual({ hostA: 300_000, hostB: null })
  })
})
