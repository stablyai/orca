import { describe, expect, it } from 'vitest'
import type { KeybindingFileDiagnostic } from '../../shared/keybindings/types'
import { parseBindingSection } from './keybinding-file-parser'

describe('parseBindingSection', () => {
  it('skips a saved binding for the retired workspace.delete action without a warning', () => {
    const diagnostics: KeybindingFileDiagnostic[] = []
    const overrides = parseBindingSection(
      { 'workspace.delete': ['Mod+Shift+Backspace'], 'not.an.action': ['Mod+K'] },
      'keybindings',
      diagnostics
    )

    expect(overrides).toEqual({})
    expect(diagnostics.map((diagnostic) => diagnostic.actionId)).toEqual(['not.an.action'])
  })
})
