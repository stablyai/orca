import { describe, expect, it } from 'vitest'
import { applyGpuFallbackCommandLineSwitches } from './gpu-fallback-switches'

function recordingCommandLine() {
  const appended: string[] = []
  return {
    appended,
    commandLine: {
      appendSwitch: (name: string) => appended.push(name)
    }
  }
}

describe('applyGpuFallbackCommandLineSwitches', () => {
  it('keeps the Windows fallback on the in-process switch set', () => {
    const { appended, commandLine } = recordingCommandLine()
    expect(applyGpuFallbackCommandLineSwitches(commandLine, 'win32')).toEqual([
      'disable-gpu',
      'disable-software-rasterizer',
      'in-process-gpu'
    ])
    expect(appended).toEqual(['disable-gpu', 'disable-software-rasterizer', 'in-process-gpu'])
  })

  it('recovers Linux with software compositing and no in-process GPU', () => {
    const { commandLine } = recordingCommandLine()
    expect(applyGpuFallbackCommandLineSwitches(commandLine, 'linux')).toEqual([
      'disable-gpu',
      'disable-gpu-compositing'
    ])
  })

  it('applies no fallback switches on unsupported platforms', () => {
    const { appended, commandLine } = recordingCommandLine()
    expect(applyGpuFallbackCommandLineSwitches(commandLine, 'darwin')).toEqual([])
    expect(appended).toEqual([])
  })
})
