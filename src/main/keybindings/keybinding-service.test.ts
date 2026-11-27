import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getUnavailableKeybindingActionIds } from './keybinding-feature-gates'
import { resolveWindowShortcutAction } from '../../shared/keybindings/window-shortcut-policy'
import { KeybindingService } from './keybinding-service'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('KeybindingService dispatch overrides', () => {
  it('keeps a switched-off dashboard chord stored but stops it claiming the key', () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-keybindings-'))
    homes.push(homePath)
    let dashboardEnabled = true
    const service = new KeybindingService({
      homePath,
      platform: 'darwin',
      getUnavailableActionIds: () =>
        getUnavailableKeybindingActionIds({ experimentalAgentDashboardPopout: dashboardEnabled })
    })
    service.setActionBindings('dashboard.toggle', ['Mod+Alt+Shift+J'])
    const chord = { type: 'keyDown', key: 'j', code: 'KeyJ', meta: true, alt: true, shift: true }

    expect(resolveWindowShortcutAction(chord, 'darwin', service.getOverrides())).toEqual({
      type: 'toggleAgentDashboard'
    })

    dashboardEnabled = false
    expect(resolveWindowShortcutAction(chord, 'darwin', service.getOverrides())).toBeNull()
    expect(service.getSnapshot().overrides['dashboard.toggle']).toEqual(['Mod+Alt+Shift+J'])

    dashboardEnabled = true
    expect(resolveWindowShortcutAction(chord, 'darwin', service.getOverrides())).toEqual({
      type: 'toggleAgentDashboard'
    })
  })
})
