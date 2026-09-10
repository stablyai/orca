import { describe, expect, it, vi } from 'vitest'
import { applyGpuFallbackCommandLineSwitches } from './gpu-fallback-switches'

describe('GPU fallback command-line switches', () => {
  it('applies nothing outside Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const appendSwitch = vi.fn()
      expect(applyGpuFallbackCommandLineSwitches({ appendSwitch }, platform)).toEqual([])
      expect(appendSwitch).not.toHaveBeenCalled()
    }
  })

  // Why: measured on Windows 11 / Electron 43.1.0 — `--disable-gpu` alone still reports
  // GPU: 1 in app.getAppMetrics(); adding --in-process-gpu drops it to 0.
  it('appends exactly the measured switch set to the Electron command line', () => {
    const appendSwitch = vi.fn()
    const appliedSwitches = applyGpuFallbackCommandLineSwitches({ appendSwitch }, 'win32')
    expect(appliedSwitches).toEqual([
      'disable-gpu',
      'disable-software-rasterizer',
      'in-process-gpu'
    ])
    expect(appendSwitch.mock.calls.map(([name]) => name)).toEqual(appliedSwitches)
  })

  // Why: only an explicitly requested Linux dev session may apply the fallback — packaged Linux
  // keeps hardware acceleration and macOS is untouched.
  it('applies the same set to a Linux dev session but not plain Linux', () => {
    const devAppend = vi.fn()
    const applied = applyGpuFallbackCommandLineSwitches({ appendSwitch: devAppend }, 'linux', {
      linuxDevFallback: true
    })
    expect(applied).toEqual(['disable-gpu', 'disable-software-rasterizer', 'in-process-gpu'])
    expect(devAppend.mock.calls.map(([name]) => name)).toEqual(applied)

    const packagedAppend = vi.fn()
    expect(applyGpuFallbackCommandLineSwitches({ appendSwitch: packagedAppend }, 'linux')).toEqual(
      []
    )
    expect(packagedAppend).not.toHaveBeenCalled()

    const macAppend = vi.fn()
    expect(
      applyGpuFallbackCommandLineSwitches({ appendSwitch: macAppend }, 'darwin', {
        linuxDevFallback: true
      })
    ).toEqual([])
    expect(macAppend).not.toHaveBeenCalled()
  })
})
