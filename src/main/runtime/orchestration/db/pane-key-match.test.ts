import { describe, expect, it } from 'vitest'
import {
  isEquivalentPaneKey,
  paneKeyMatchSuffix,
  parseWorkerTerminalPriorOwnerIds
} from './pane-key-match'

describe('pane-key-match', () => {
  it('treats identical keys and same leaf UUIDs as equivalent', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    expect(isEquivalentPaneKey('tab-a', 'tab-a')).toBe(true)
    expect(isEquivalentPaneKey(`tab-a:${leaf}`, `tab-b:${leaf}`)).toBe(true)
    expect(isEquivalentPaneKey(`tab-a:${leaf}`, `tab-a:22222222-2222-4222-8222-222222222222`)).toBe(
      false
    )
  })

  it('uses the text after the first colon as the indexable suffix', () => {
    expect(paneKeyMatchSuffix('no-colon')).toBe('no-colon')
    expect(paneKeyMatchSuffix('tab:leaf')).toBe('leaf')
    expect(paneKeyMatchSuffix('tab:leaf:extra')).toBe('leaf:extra')
  })

  it('parses a string array of prior owner ids and rejects other JSON', () => {
    expect(parseWorkerTerminalPriorOwnerIds('["a","b"]')).toEqual(['a', 'b'])
    expect(parseWorkerTerminalPriorOwnerIds('[1]')).toBeNull()
    expect(parseWorkerTerminalPriorOwnerIds('not-json')).toBeNull()
  })
})
