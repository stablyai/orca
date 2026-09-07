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

  it('removes a bare key from the first tui table body', () => {
    expect(
      removePromotedSettingsFromContent(
        '[tui]\ntheme = "dark"\nanimations = true\n\n[tui.notifications]\ntheme = "nested"\n',
        new Set(['tui.theme'])
      )
    ).toBe('[tui]\nanimations = true\n\n[tui.notifications]\ntheme = "nested"\n')
  })

  it('removes dotted and quoted dotted tui keys from the preamble', () => {
    expect(
      removePromotedSettingsFromContent(
        'tui.theme = "dark"\n"tui" . "status_line" = ["model"]\n',
        new Set(['tui.theme', 'tui.status_line'])
      )
    ).toBe('')
  })

  it('does not remove a tui-shaped key inside another table', () => {
    const content = '[[profiles]]\ntui.theme = "profile-theme"\n'
    expect(removePromotedSettingsFromContent(content, new Set(['tui.theme']))).toBe(content)
  })

  it('does not remove a nested tui descendant with the same first segment', () => {
    const content = '[tui]\ntheme.variant = "dark"\n'
    expect(removePromotedSettingsFromContent(content, new Set(['tui.theme']))).toBe(content)
  })
})
