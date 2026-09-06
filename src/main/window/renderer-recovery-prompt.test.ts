import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ensureMainI18n, mainI18n } from '../i18n/main-i18n'
import type { InstallDirAclPoisonDiagnosis } from '../startup/windows-install-dir-acl-recovery'
import {
  presentRendererRecoveryPrompt,
  type RendererRecoveryPromptDeps
} from './renderer-recovery-prompt'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }))

const POISON: InstallDirAclPoisonDiagnosis = {
  detail: "Windows permissions on Orca's install folder are blocking its own sandboxed processes.",
  commands: ['icacls "C:\\Orca" /grant "*S-1-15-2-2:(OI)(CI)(RX)"', 'icacls "C:\\Orca" /grant b']
}

function harness(overrides: Partial<RendererRecoveryPromptDeps> & { responses?: number[] } = {}): {
  run: () => Promise<void>
  shown: MessageBoxOptions[]
  copied: string[]
  reload: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
} {
  const { responses = [0], ...rest } = overrides
  const shown: MessageBoxOptions[] = []
  const copied: string[] = []
  const reload = vi.fn()
  const quit = vi.fn()
  const deps: RendererRecoveryPromptDeps = {
    recentRecoveryCount: 4,
    isQuitting: () => false,
    diagnose: () => null,
    showMessageBox: async (options: MessageBoxOptions): Promise<MessageBoxReturnValue> => {
      shown.push(options)
      return {
        response: responses[Math.min(shown.length - 1, responses.length - 1)],
        checkboxChecked: false
      }
    },
    copyToClipboard: (text) => copied.push(text),
    reload,
    quit,
    ...rest
  }
  return { run: () => presentRendererRecoveryPrompt(deps), shown, copied, reload, quit }
}

describe('presentRendererRecoveryPrompt', () => {
  beforeEach(async () => {
    await ensureMainI18n()
    await mainI18n.changeLanguage('en')
  })

  afterEach(() => {
    mainI18n.removeResourceBundle('en', 'translation')
  })

  it('interpolates the recovery count', async () => {
    const { run, shown } = harness({ recentRecoveryCount: 7 })
    await run()
    expect(shown[0].detail).toContain('Orca tried to recover 7 times in a row')
    expect(shown[0].detail).not.toContain('{{')
  })

  it.each([
    { responses: [1, 0], reloads: 1, quits: 0 },
    { responses: [1, 2], reloads: 0, quits: 1 }
  ])(
    'dispatches translated buttons by response index: $responses',
    async ({ responses, reloads, quits }) => {
      mainI18n.addResourceBundle('en', 'translation', {
        rendererRecovery: { reload: 'Recharger', copyCommands: 'Copier', quit: 'Quitter' }
      })
      const { run, shown, copied, reload, quit } = harness({ diagnose: () => POISON, responses })
      await run()
      expect(shown[0].buttons).toEqual(['Recharger', 'Copier', 'Quitter'])
      expect(copied).toEqual([POISON.commands.join('\r\n')])
      expect(reload).toHaveBeenCalledTimes(reloads)
      expect(quit).toHaveBeenCalledTimes(quits)
    }
  )

  it('offers reload and quit with the generic cause when nothing is diagnosed', async () => {
    const { run, shown, reload, quit } = harness({ responses: [0] })
    await run()
    expect(shown).toHaveLength(1)
    expect(shown[0].buttons).toEqual(['Reload', 'Quit'])
    // Escape lands on cancelId, and this box is window-modal over the window it is about: it must not quit.
    expect(shown[0].cancelId).toBe(0)
    expect(shown[0].detail).toContain('graphics-driver or installation problem')
    expect(reload).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
  })

  it('names the stalled reload instead of claiming a repeated crash', async () => {
    const { run, shown } = harness({ failure: 'reload-stalled', responses: [1] })
    await run()
    expect(shown[0].message).toContain('stopped responding while reloading')
    expect(shown[0].detail).toContain('never finished loading')
    expect(shown[0].detail).not.toContain('times in a row')
  })

  it('quits on the last button', async () => {
    const { run, reload, quit } = harness({ responses: [1] })
    await run()
    expect(quit).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })

  it('names the install-permission cause and keeps the driver hint', async () => {
    const { run, shown } = harness({ diagnose: () => POISON, responses: [0] })
    await run()
    expect(shown[0].buttons).toEqual(['Reload', 'Copy Commands', 'Quit'])
    expect(shown[0].cancelId).toBe(0)
    expect(shown[0].detail).toContain(POISON.detail)
    expect(shown[0].detail).toContain('graphics driver')
  })

  // The window is blank, so dismissing the dialog to copy would leave no way back.
  it('keeps the dialog up after copying the commands, then still reloads', async () => {
    const { run, shown, copied, reload, quit } = harness({
      diagnose: () => POISON,
      responses: [1, 1, 0]
    })
    await run()
    expect(copied).toEqual([POISON.commands.join('\r\n'), POISON.commands.join('\r\n')])
    expect(shown).toHaveLength(3)
    expect(reload).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits on the third button once the diagnosis adds one', async () => {
    const { run, quit, copied } = harness({ diagnose: () => POISON, responses: [2] })
    await run()
    expect(quit).toHaveBeenCalledOnce()
    expect(copied).toEqual([])
  })

  it('shows nothing once the app is already quitting', async () => {
    const { run, shown } = harness({ isQuitting: () => true })
    await run()
    expect(shown).toEqual([])
  })

  // The repair lands asynchronously, so a prompt raised while it ran must pick up
  // the settled copy on the next pass rather than keep saying "repairing now".
  it('re-reads the diagnosis on every pass', async () => {
    const details = ['repairing now', 'repaired']
    let pass = 0
    const { run, shown } = harness({
      diagnose: () => ({ detail: details[Math.min(pass++, 1)], commands: POISON.commands }),
      responses: [1, 0]
    })
    await run()
    expect(shown[0].detail).toContain('repairing now')
    expect(shown[1].detail).toContain('repaired')
  })
})
