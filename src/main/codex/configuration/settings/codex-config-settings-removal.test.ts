import { describe, expect, it } from 'vitest'
import { removePromotedSettingsFromContent } from './codex-config-settings-removal'

describe('removePromotedSettingsFromContent', () => {
  it('removes a top-level preamble key without touching nested copies', () => {
    expect(
      removePromotedSettingsFromContent(
        'model = "root"\n\n[profiles.dev]\nmodel = "nested"\n',
        new Set(['model'])
      )
    ).toBe('\n[profiles.dev]\nmodel = "nested"\n')
  })

  it('removes dotted and quoted dotted tui keys from the preamble', () => {
    expect(
      removePromotedSettingsFromContent(
        'tui.theme = "dark"\n"tui" . "status_line" = ["model"]\n',
        new Set(['tui.theme', 'tui.status_line'])
      )
    ).toBe('')
  })

  it('does not remove a nested tui descendant with the same first segment', () => {
    const content = '[tui]\ntheme.variant = "dark"\n'
    expect(removePromotedSettingsFromContent(content, new Set(['tui.theme']))).toBe(content)
  })
})
