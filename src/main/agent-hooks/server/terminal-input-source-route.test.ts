import { describe, expect, it } from 'vitest'
import { parseTerminalInputSourcePath } from './terminal-input-source-route'

describe('parseTerminalInputSourcePath', () => {
  it('returns the pane key from the route, raw or percent-encoded', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(parseTerminalInputSourcePath(`/pane/${paneKey}/last-input`)).toBe(paneKey)
    expect(parseTerminalInputSourcePath(`/pane/${encodeURIComponent(paneKey)}/last-input`)).toBe(
      paneKey
    )
  })

  it('rejects every other shape', () => {
    expect(parseTerminalInputSourcePath('/hook/claude')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane//last-input')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane/a/b/last-input')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane/a/last-input/')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane/%E0%A4%A/last-input')).toBeNull()
  })
})
