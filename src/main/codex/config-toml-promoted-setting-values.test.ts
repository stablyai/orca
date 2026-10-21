import { describe, expect, it } from 'vitest'
import { readPromotedSettingValuesFromContent } from './config-toml-promoted-setting-values'

describe('readPromotedSettingValuesFromContent', () => {
  it('reads bare, dotted and table-body keys by structured path', () => {
    const values = readPromotedSettingValuesFromContent(
      'model = "o4"\ntui.theme = "dark"\n\n[features]\ndaemon_auto_start = false\n'
    )
    expect([...values.keys()]).toEqual(['model', 'tui.theme', 'features.daemon_auto_start'])
  })

  it('does not read a quoted key containing a dot as a table key', () => {
    const values = readPromotedSettingValuesFromContent(
      '"tui.theme" = "dark"\n\n[features]\n"daemon_auto_start.x" = false\n'
    )
    expect(values.size).toBe(0)
  })
})
