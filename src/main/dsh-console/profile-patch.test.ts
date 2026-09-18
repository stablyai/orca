import { describe, expect, it } from 'vitest'
import { hasDshConsolePatch, updateDshConsolePatch } from './profile-patch'

describe('DSH Console managed profile patch', () => {
  it('preserves comments, executable YAML tags and user overrides across install/remove', () => {
    const source = '# user comment\n- id: runner\n  config:\n    prompt: !!js ctx.startup.prompt\n'
    const installed = updateDshConsolePatch(source, true)
    expect(installed).toContain('# user comment')
    expect(installed).toContain('!!js ctx.startup.prompt')
    expect(hasDshConsolePatch(installed)).toBe(true)
    expect(updateDshConsolePatch(installed, true)).toBe(installed)
    const removed = updateDshConsolePatch(installed, false)
    expect(hasDshConsolePatch(removed)).toBe(false)
    expect(removed).toContain('!!js ctx.startup.prompt')
    expect(updateDshConsolePatch(removed, false)).toBe(removed)
  })
  it('initializes an empty profile without requiring the CLI to have launched', () => {
    expect(hasDshConsolePatch(updateDshConsolePatch(null, true))).toBe(true)
  })
  it('rejects invalid YAML and conflicting entries without rewriting them', () => {
    expect(() => updateDshConsolePatch('config: {}', true)).toThrow('array')
    expect(() => updateDshConsolePatch('[', true)).toThrow('Invalid')
    expect(() =>
      updateDshConsolePatch(
        '- insert:\n  - id: orca-dsh-console-status\n    name: user-plugin\n',
        true
      )
    ).toThrow('conflicting')
  })
})
