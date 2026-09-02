import { describe, expect, it } from 'vitest'
import { resolveStableForegroundProcess } from './stable-foreground-process'

describe('resolveStableForegroundProcess', () => {
  it('reports the last recognized agent when a scan is unavailable (Windows CIM timeout)', () => {
    // A degraded scan falls back to the shell name. Without this, the shell
    // reads as "agent exited" and fires a false completion while it still works.
    const result = resolveStableForegroundProcess(
      { available: false, processName: 'powershell.exe' },
      'claude'
    )
    expect(result.processName).toBe('claude')
    expect(result.lastRecognizedAgent).toBe('claude')
  })

  it('remembers the agent from a completed scan that found it', () => {
    const result = resolveStableForegroundProcess({ available: true, processName: 'claude' }, null)
    expect(result.processName).toBe('claude')
    expect(result.lastRecognizedAgent).toBe('claude')
  })

  it('reports a real exit and clears memory when a completed scan finds no agent', () => {
    // Regression guard: a genuine exit/crash must still be detectable — an
    // authoritative (available) scan with no agent overrides the memory.
    const result = resolveStableForegroundProcess(
      { available: true, processName: 'powershell.exe' },
      'claude'
    )
    expect(result.processName).toBe('powershell.exe')
    expect(result.lastRecognizedAgent).toBeNull()
  })

  it('passes through when a scan is unavailable and nothing is remembered', () => {
    const result = resolveStableForegroundProcess(
      { available: false, processName: 'powershell.exe' },
      null
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
