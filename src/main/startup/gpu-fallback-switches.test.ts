import { describe, expect, it, vi } from 'vitest'
import { applyGpuFallbackCommandLineSwitches } from './gpu-fallback-switches'

describe('GPU fallback command-line switches', () => {
  it('applies nothing on unsupported platforms like macOS', () => {
    for (const platform of ['darwin', 'aix', 'freebsd', 'openbsd', 'sunos'] as const) {
      const appendSwitch = vi.fn()
      expect(applyGpuFallbackCommandLineSwitches({ appendSwitch }, platform)).toEqual([])
      expect(appendSwitch).not.toHaveBeenCalled()
    }
  })

  // Why: measured on Windows 11 / Electron 43.1.0 and Linux / Electron 43.6.0 — `--disable-gpu` alone still
  // leaves GPU process initialization paths active; adding --in-process-gpu drops it cleanly to software mode.
  it('appends exactly the measured switch set on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const appendSwitch = vi.fn()
      const appliedSwitches = applyGpuFallbackCommandLineSwitches({ appendSwitch }, platform)
      expect(appliedSwitches).toEqual([
        'disable-gpu',
        'disable-software-rasterizer',
        'in-process-gpu'
      ])
      expect(appendSwitch.mock.calls.map(([name]) => name)).toEqual(appliedSwitches)
    }
  })
})
