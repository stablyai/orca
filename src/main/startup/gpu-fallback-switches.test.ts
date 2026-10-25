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

  // Windows 11/Electron 43.1: disable-gpu leaves one GPU child; in-process-gpu removes it.
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
})
