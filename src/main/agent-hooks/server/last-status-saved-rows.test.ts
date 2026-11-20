// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assemble, ROW_KEY_SEPARATOR, rowKeyFor, rowsOf } from './last-status-saved-rows'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

// node:sqlite stores TEXT as a C string on Windows and truncates at the first NUL. The row keys
// used to be built with a NUL separator, so every key collapsed to its bare kind there and a
// restart restored no status at all. The separator must never be NUL again.
describe('last-status row keys', () => {
  it('never puts NUL in a row key', () => {
    for (const kind of ['entry', 'commitment', 'exits'] as const) {
      const key = rowKeyFor(kind, PANE)
      expect(key).not.toContain('\u0000')
      expect(key.startsWith(`${kind}${ROW_KEY_SEPARATOR}`)).toBe(true)
    }
  })

  it('round-trips entries, commitments and exits through rowsOf/assemble', () => {
    const file = {
      version: 2 as const,
      entries: {
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-1',
          receivedAt: 1,
          payload: { state: 'done' as const }
        }
      },
      authorityCommitments: {
        [PANE]: { paneKey: PANE, launchTokenHash: 'abc' }
      },
      agentExits: [{ paneKey: PANE, exitedAt: 1 }]
    }
    const assembled = assemble(rowsOf(file as never))
    expect(Object.keys(assembled.entries)).toEqual([PANE])
    expect(Object.keys(assembled.authorityCommitments)).toEqual([PANE])
    expect(assembled.agentExits).toHaveLength(1)
  })

  it('drops a key an older NUL-truncated writer left behind', () => {
    // Before the fix a Windows write stored the bare kind: the row cannot name its pane.
    const assembled = assemble([{ key: 'entry', json: JSON.stringify({ paneKey: PANE }) }])
    expect(assembled.entries).toEqual({})
  })
})
