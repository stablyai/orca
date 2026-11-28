import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getEffectiveKeybindingsForAction } from '../../shared/keybindings/effective'
import { KeybindingService } from './keybinding-service'
import { getUserKeybindingsPath } from './keybinding-file'

let homePath = ''
let active = false

const service = () =>
  new KeybindingService({
    homePath,
    platform: 'darwin',
    getFloatingWorkspaceShortcutsActive: () => active
  })

function writeUserFile(document: unknown): string {
  const path = getUserKeybindingsPath(homePath)
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(document)
  writeFileSync(path, bytes)
  return bytes
}

describe('keybindings while the floating workspace is inactive', () => {
  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), 'orca-floating-keybindings-'))
    active = false
  })

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true })
  })

  it('saves a user binding on the floating chord and keeps it across a restart', () => {
    const saved = service().setActionBindings('tab.newTerminal', ['Mod+Alt+A'])
    expect(saved.overrides['tab.newTerminal']).toEqual(['Mod+Alt+A'])
    expect(saved.diagnostics).toEqual([])
    expect(saved.floatingWorkspaceShortcutsActive).toBe(false)

    const restarted = service().getSnapshot()
    expect(restarted.overrides['tab.newTerminal']).toEqual(['Mod+Alt+A'])
    expect(restarted.diagnostics).toEqual([])
  })

  it('blocks the clash only while active and never rewrites the file', () => {
    const bytes = writeUserFile({ version: 1, keybindings: {} })
    active = true
    expect(() => service().setActionBindings('tab.newTerminal', ['Mod+Alt+A'])).toThrow(
      /conflicts with another shortcut/
    )
    expect(readFileSync(getUserKeybindingsPath(homePath), 'utf8')).toBe(bytes)
    active = false
    expect(service().setActionBindings('tab.newTerminal', ['Mod+Alt+A']).diagnostics).toEqual([])
  })

  it('republishes on each flip so an inactive remap stops claiming a yielding default', () => {
    writeUserFile({
      version: 1,
      keybindings: { 'floatingTerminal.toggle': ['Mod+Shift+J'] }
    })
    const keybindings = service()
    const toggleNativeChat = () =>
      getEffectiveKeybindingsForAction(
        'terminal.toggleNativeChat',
        'darwin',
        keybindings.getOverrides()
      )
    const first = keybindings.getSnapshot()
    expect(first.overrides['floatingTerminal.toggle']).toBeUndefined()
    expect(toggleNativeChat()).toContain('Mod+Shift+J')
    // The chord stays live and single-owned; the inert remap neither blocks nor shares it.
    expect(
      keybindings.setActionBindings('workspace.openBoard', ['Mod+Shift+J']).diagnostics
    ).toEqual([])
    expect(toggleNativeChat()).not.toContain('Mod+Shift+J')
    keybindings.setActionBindings('workspace.openBoard', null)
    expect(toggleNativeChat()).toContain('Mod+Shift+J')

    active = true
    const on = keybindings.reload()
    expect(on.overrides['floatingTerminal.toggle']).toEqual(['Mod+Shift+J'])
    expect(toggleNativeChat()).not.toContain('Mod+Shift+J')

    active = false
    const off = keybindings.reload()
    expect(off.overrides['floatingTerminal.toggle']).toBeUndefined()
    expect(toggleNativeChat()).toContain('Mod+Shift+J')
    expect(off.generation).toBeGreaterThan(on.generation ?? 0)
    expect(on.generation).toBeGreaterThan(first.generation ?? 0)
    const saved = JSON.parse(readFileSync(getUserKeybindingsPath(homePath), 'utf8'))
    expect(saved.keybindings['floatingTerminal.toggle']).toEqual(['Mod+Shift+J'])
    expect(service().getSnapshot().overrides['floatingTerminal.toggle']).toBeUndefined()
  })
})
