import { describe, expect, it } from 'vitest'
import { parseLoadedStatsFile } from './stats-retention'

describe('stats file JSON admission', () => {
  it('preserves ordinary stats under the structure limits', () => {
    expect(
      parseLoadedStatsFile('{"schemaVersion":1,"events":[],"aggregates":{}}', {
        structuralTokens: 11,
        nestingDepth: 2
      })
    ).toMatchObject({ schemaVersion: 1, events: [] })
  })

  it('rejects structural amplification before parsing stats', () => {
    expect(() =>
      parseLoadedStatsFile('{"events":[{},{}]}', {
        structuralTokens: 7,
        nestingDepth: 3
      })
    ).toThrow('JSON structure')
  })
})
