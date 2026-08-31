import { describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { editTomlStringSetting } from './config-toml-string-setting'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'

const path = ['shell_environment_policy', 'set', 'ORCA_USER_DATA_PATH']
const profile = 'C:\\Orca\\profile'
const quoteCases = ['"', "'"].flatMap((quote) =>
  [4, 5].map((closingQuotes) => ({ quote, closingQuotes }))
)
const placements = [
  (value: string) =>
    `[shell_environment_policy.set]\nORCA_USER_DATA_PATH = ${value}\nKEEP = "yes"\n`,
  (value: string) =>
    `shell_environment_policy.set.ORCA_USER_DATA_PATH = ${value}\nshell_environment_policy.set.KEEP = "yes"\n`,
  (value: string) =>
    `[shell_environment_policy]\nset = { ORCA_USER_DATA_PATH = ${value}, KEEP = "yes" }\n`,
  (value: string) =>
    `shell_environment_policy = { set = { KEEP = "yes", ORCA_USER_DATA_PATH = ${value} } }\n`
]

describe.each(quoteCases)(
  'multiline $quote closing with $closingQuotes quotes',
  ({ quote, closingQuotes }) => {
    it.each(placements)('replaces the entire valid string span (%#)', (place) => {
      const original = place(`${quote.repeat(3)}stale${quote.repeat(closingQuotes)}`)
      expect(parse(original)).toEqual({
        shell_environment_policy: {
          set: { KEEP: 'yes', ORCA_USER_DATA_PATH: `stale${quote.repeat(closingQuotes - 3)}` }
        }
      })
      const edited = editTomlStringSetting(original, path, profile)
      expect(parse(edited)).toEqual({
        shell_environment_policy: { set: { KEEP: 'yes', ORCA_USER_DATA_PATH: profile } }
      })
      expect(editTomlStringSetting(edited, path, profile)).toBe(edited)
    })

    it.each(placements)(
      'removes the full string when reconstructing system config (%#)',
      (place) => {
        const original = place(`${quote.repeat(3)}stale${quote.repeat(closingQuotes)}`)
        parse(original)
        expect(parse(extractOrdinaryCodexSettings(original))).toEqual({
          shell_environment_policy: { set: { KEEP: 'yes' } }
        })
      }
    )

    it('skips a multiline sibling with closing quote content in an inline table', () => {
      const original = `shell_environment_policy = { set = { KEEP = ${quote.repeat(3)}keep${quote.repeat(closingQuotes)} } }\n`
      const before = parse(original)
      const edited = editTomlStringSetting(original, path, profile)
      expect(parse(edited)).toEqual({
        shell_environment_policy: {
          set: { KEEP: `keep${quote.repeat(closingQuotes - 3)}`, ORCA_USER_DATA_PATH: profile }
        }
      })
      expect(parse(extractOrdinaryCodexSettings(edited))).toEqual(before)
    })
  }
)

describe('array comments inside inline environment policy', () => {
  it.each([']', '}', '"unterminated', "'''", '[{'])(
    'does not treat comment text %s as structure',
    (comment) => {
      const original = `shell_environment_policy = { inherit = "core", exclude = [\n "SECRET", # ${comment} comment\n], set = { KEEP = "yes" } }\n`
      const before = parse(original)
      const edited = editTomlStringSetting(original, path, profile)
      expect(parse(edited)).toEqual({
        shell_environment_policy: {
          inherit: 'core',
          exclude: ['SECRET'],
          set: { KEEP: 'yes', ORCA_USER_DATA_PATH: profile }
        }
      })
      expect(edited).toContain(`exclude = [\n "SECRET", # ${comment} comment\n]`)
      expect(parse(extractOrdinaryCodexSettings(edited))).toEqual(before)
    }
  )
})
