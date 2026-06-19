import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalAutoRestoreFitMs,
  setTerminalAutoRestoreFitMsForHost
} from './terminal-auto-restore-fit-state'

describe('terminal auto restore fit state', () => {
  it('normalizes missing server values to the default indefinite value', () => {
    expect(normalizeTerminalAutoRestoreFitMs(undefined)).toBeNull()
    expect(normalizeTerminalAutoRestoreFitMs(null)).toBeNull()
    expect(normalizeTerminalAutoRestoreFitMs(60_000)).toBe(60_000)
  })

  it('returns the existing state object when a host value is unchanged', () => {
    const current = { hostA: 60_000, hostB: null }

    expect(setTerminalAutoRestoreFitMsForHost(current, 'hostA', 60_000)).toBe(current)
    expect(setTerminalAutoRestoreFitMsForHost(current, 'hostB', undefined)).toBe(current)
  })

  it('updates one host while preserving other host values', () => {
    const current = { hostA: 60_000, hostB: null }
    const next = setTerminalAutoRestoreFitMsForHost(current, 'hostA', 300_000)

    expect(next).not.toBe(current)
    expect(next).toEqual({ hostA: 300_000, hostB: null })
  })
})
