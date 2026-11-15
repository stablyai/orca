import { describe, expect, it } from 'vitest'
import { fixPatch } from './theme-studio-fixes'

const finding = (id: string, token: string, value: string) => ({
  id,
  rule: 'text' as const,
  tokens: [token],
  effect: 'x',
  fixes: [{ strategy: 'text-lightness' as const, set: { [token]: value } }]
})

describe('fixPatch', () => {
  const report = {
    revision: 1,
    modes: [
      {
        mode: 'light' as const,
        shown: false,
        findings: [finding('l1', '--foreground', '#111111')]
      },
      { mode: 'dark' as const, shown: true, findings: [finding('d1', '--foreground', '#eeeeee')] }
    ]
  }

  it('fixes every mode by default', () => {
    expect(fixPatch(report).fixed).toEqual(['l1', 'd1'])
  })

  it('leaves modes outside onlyModes alone, so pair keeps the mode it came from', () => {
    const { patch, fixed } = fixPatch(report, undefined, ['light'])
    expect(fixed).toEqual(['l1'])
    expect(patch.dark).toBeUndefined()
  })
})
