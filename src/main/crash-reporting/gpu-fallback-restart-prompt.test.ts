import { afterEach, describe, expect, it } from 'vitest'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../shared/ui-language'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { gpuFallbackRestartOptions } from './gpu-fallback-restart-prompt'

afterEach(async () => {
  await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
})

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

  it('keeps the Linux detail out of a catalog that translated the Windows WebGL text', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)

    const windowsDetail = String(gpuFallbackRestartOptions('win32').detail)
    const linuxDetail = String(gpuFallbackRestartOptions('linux').detail)

    // The catalog translates the shared key, which names WebGL; Linux must not reuse it.
    expect(windowsDetail).toContain('WebGL')
    expect(windowsDetail).not.toBe(linuxDetail)
    expect(linuxDetail).toContain('Software rendering may keep WebGL available')
  })
})
