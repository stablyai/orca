import { describe, expect, it } from 'vitest'
import { readPromotedSettingValuesFromContent } from './config-toml-promoted-setting-values'

describe('readPromotedSettingValuesFromContent', () => {
  it('reads values and multiline flags by structured path', () => {
    const values = readPromotedSettingValuesFromContent(
      'model = "o4"\ntui.theme = "dark"\ntui.status_line = [\n  "model"\n]\n\n[features]\ndaemon_auto_start = false\n'
    )
    expect([...values]).toEqual([
      ['model', { raw: '"o4"', multiline: false }],
      ['tui.theme', { raw: '"dark"', multiline: false }],
      ['tui.status_line', { raw: '[', multiline: true }],
      ['features.daemon_auto_start', { raw: 'false', multiline: false }]
    ])
  })

  it('does not read a quoted key containing a dot as a table key', () => {
    const values = readPromotedSettingValuesFromContent(
      '"tui.theme" = "dark"\n\n[features]\n"daemon_auto_start.x" = false\n'
    )
    expect(values.size).toBe(0)
  })
})
