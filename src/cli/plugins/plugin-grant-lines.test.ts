import { describe, expect, it } from 'vitest'
import { formatPluginGrantLines } from './plugin-grant-lines'

describe('formatPluginGrantLines', () => {
  it('counts same-named contributions on one line', () => {
    const lines = formatPluginGrantLines({
      pluginKey: 'local.ember',
      version: '1.0.0',
      grants: {
        execution: 'data',
        executionDescription: 'Content only.',
        capabilities: [],
        contributions: [
          { kind: 'themes', name: 'Ember' },
          { kind: 'themes', name: 'Ember' },
          { kind: 'terminalThemes', name: 'Ember' },
          { kind: 'iconThemes', name: 'Embers' }
        ]
      }
    })
    expect(lines.slice(2)).toEqual([
      '  adds themes: Ember (2 variants)',
      '  adds terminalThemes: Ember',
      '  adds iconThemes: Embers'
    ])
  })
})
