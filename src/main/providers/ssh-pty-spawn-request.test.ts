import { describe, expect, it } from 'vitest'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'

describe('buildSshPtySpawnRequest', () => {
  it('forwards live OSC color replies to the relay host', () => {
    const oscColorQueryReplies = { foreground: '#2e3434', background: '#ffffff' }

    expect(
      buildSshPtySpawnRequest({
        options: { cols: 80, rows: 24, oscColorQueryReplies },
        supportsCreateOperation: false
      })
    ).toMatchObject({ oscColorQueryReplies })
  })

  it('omits live OSC color replies when the client has none', () => {
    expect(
      buildSshPtySpawnRequest({
        options: { cols: 80, rows: 24 },
        supportsCreateOperation: false
      })
    ).not.toHaveProperty('oscColorQueryReplies')
  })
})
