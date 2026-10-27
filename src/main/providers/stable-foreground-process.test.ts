import { describe, expect, it } from 'vitest'
import { resolveStableForegroundProcess } from './stable-foreground-process'

describe('resolveStableForegroundProcess', () => {
  it('reports the last recognized agent when a scan is unavailable (Windows CIM timeout)', () => {
    // Scan failure must not look like agent exit merely because the fallback names its shell.
    const result = resolveStableForegroundProcess(
      { available: false, processName: 'powershell.exe' },
      'claude'
    )
    expect(result.processName).toBe('claude')
    expect(result.lastRecognizedAgent).toBe('claude')
  })

  it('reports a real exit and clears memory when a completed scan finds no agent', () => {
    const result = resolveStableForegroundProcess(
      { available: true, processName: 'powershell.exe' },
      'claude'
    )
    expect(result.processName).toBe('powershell.exe')
    expect(result.lastRecognizedAgent).toBeNull()
  })

  it('prefers the remembered agent even when a degraded scan returns null', () => {
    const result = resolveStableForegroundProcess({ available: false, processName: null }, 'codex')
    expect(result.processName).toBe('codex')
    expect(result.lastRecognizedAgent).toBe('codex')
  })
})
