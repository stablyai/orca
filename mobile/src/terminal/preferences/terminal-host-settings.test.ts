import { describe, expect, it } from 'vitest'
import { terminalHostSettingsRead } from './terminal-host-settings'

function read(settings: Record<string, unknown>) {
  return terminalHostSettingsRead.interpret({ id: '1', ok: true, result: { settings } })
}

describe('terminalHostSettingsRead', () => {
  it('follows the desktop scrollback up to the phone cap and keeps a custom word separator', () => {
    expect(read({ terminalScrollbackRows: 3_000, terminalWordSeparator: ' ,' })).toMatchObject({
      accepted: true,
      value: { scrollbackRows: 3_000, wordSeparator: ' ,' }
    })
    expect(read({ terminalScrollbackRows: 50_000 })).toMatchObject({
      value: { scrollbackRows: 10_000, wordSeparator: ' ()[]{}\',"`' }
    })
  })

  it('reads an older host without these settings as desktop defaults', () => {
    expect(read({})).toMatchObject({
      value: { scrollbackRows: 5_000, wordSeparator: ' ()[]{}\',"`' }
    })
  })
})
