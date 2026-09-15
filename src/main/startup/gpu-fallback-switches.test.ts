import { describe, expect, it, vi } from 'vitest'
import { applyGpuFallbackCommandLineSwitches } from './gpu-fallback-switches'

describe('GPU fallback command-line switches', () => {
  it('applies nothing on unsupported platforms', () => {
    const appendSwitch = vi.fn()
    expect(applyGpuFallbackCommandLineSwitches({ appendSwitch }, 'darwin')).toEqual([])
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  // Why: measured on Windows 11 / Electron 43.1.0 — `--disable-gpu` alone still reports
  // GPU: 1 in app.getAppMetrics(); adding --in-process-gpu drops it to 0.
  it('appends exactly the measured switch set on Windows', () => {
    const appendSwitch = vi.fn()
    const appliedSwitches = applyGpuFallbackCommandLineSwitches({ appendSwitch }, 'win32')
    expect(appliedSwitches).toEqual([
      'disable-gpu',
      'disable-software-rasterizer',
      'in-process-gpu'
    ])
    expect(appendSwitch.mock.calls.map(([name]) => name)).toEqual(appliedSwitches)
  })

  it('appends the same switch set on Linux', () => {
    const appendSwitch = vi.fn()
    const appliedSwitches = applyGpuFallbackCommandLineSwitches({ appendSwitch }, 'linux')
    expect(appliedSwitches).toEqual([
      'disable-gpu',
      'disable-software-rasterizer',
      'in-process-gpu'
    ])
    expect(appendSwitch.mock.calls.map(([name]) => name)).toEqual(appliedSwitches)
  })
})
