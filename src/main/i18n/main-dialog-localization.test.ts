import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') },
  dialog: { showMessageBox: vi.fn() }
}))

describe('main-process dialog localization', () => {
  it('fills fallback placeholders before i18n is initialized', async () => {
    vi.resetModules()
    const { translateMain } = await import('./main-i18n')
    // Why: startup dialogs can render before ensureMainI18n() resolves.
    expect(
      translateMain('profileState.copyChoice.lastSaved', 'Last saved {{time}}.', { time: 'now' })
    ).toBe('Last saved now.')
    expect(translateMain('missing.key', 'Keeps {{unknown}} as is.', {})).toBe(
      'Keeps {{unknown}} as is.'
    )
  })

  it('builds dialog copy in the language active when the dialog opens', async () => {
    vi.resetModules()
    const { ensureMainI18n, setMainUiLanguage, translateMain } = await import('./main-i18n')
    const { UI_LANGUAGE_SPANISH } = await import('../../shared/ui-language')
    const { gpuFallbackRestartOptions } =
      await import('../crash-reporting/gpu-fallback-restart-prompt')
    const { chooseProfileStateCopy } =
      await import('../persistence/profile-state/profile-state-startup-recovery-dialog')
    expect(gpuFallbackRestartOptions().title).toBe('Restart Orca in Safe Graphics Mode?')

    await ensureMainI18n()
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(gpuFallbackRestartOptions()).toMatchObject({
      title: '¿Reiniciar Orca en modo de gráficos seguro?',
      buttons: ['Reiniciar en modo de gráficos seguro', 'Seguir ejecutando']
    })

    const showMessageBox = vi.fn(async () => ({ response: 2, checkboxChecked: false }))
    await chooseProfileStateCopy({
      sqliteSavedAt: new Date(0),
      formatTime: () => '1/1/1970',
      showMessageBox,
      translate: translateMain
    })
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Elegir el estado del perfil',
        detail: expect.stringContaining(
          'Se descartan los cambios hechos en la versión anterior. Guardado por última vez: 1/1/1970.'
        )
      })
    )
  })
})
