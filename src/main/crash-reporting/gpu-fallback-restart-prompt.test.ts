import { describe, expect, it } from 'vitest'
import { gpuFallbackRestartOptions } from './gpu-fallback-restart-prompt'

describe('the safe-graphics restart prompt', () => {
  it('claims WebGL stays off on Windows, whose switch list disables SwiftShader', () => {
    const detail = String(gpuFallbackRestartOptions('win32').detail)
    expect(detail).toContain('disables hardware acceleration and WebGL')
  })

  it('does not claim WebGL is disabled on Linux, which keeps software rasterization', () => {
    const detail = String(gpuFallbackRestartOptions('linux').detail)
    expect(detail).not.toContain('disables hardware acceleration and WebGL')
    expect(detail).toContain('Software rendering may keep WebGL available')
  })
})
