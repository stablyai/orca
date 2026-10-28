import { describe, expect, it } from 'vitest'
import {
  PLUGIN_MARKETPLACE_FILENAME,
  PLUGIN_MARKETPLACE_V2_FILENAME
} from '../../shared/plugins/plugin-marketplace'
import { parsePluginMarketplaceIndex } from './plugin-marketplace-fetch'

const entry = {
  id: 'samples.demo',
  source: { kind: 'git', url: 'https://example.com/demo.git', ref: 'v1.0.0' },
  categories: []
}
const release = {
  version: '1.0.0',
  commit: 'c'.repeat(40),
  contentHash: 'f'.repeat(64),
  execution: 'data',
  minimumOrca: '1.4.0',
  types: ['interface-language']
}

function parse(filename: string, catalog: unknown) {
  return parsePluginMarketplaceIndex(filename, Buffer.from(JSON.stringify(catalog)))
}

describe('parsePluginMarketplaceIndex', () => {
  it('keeps valid v2 entries next to ones this client cannot install', () => {
    const marketplace = parse(PLUGIN_MARKETPLACE_V2_FILENAME, {
      name: 'New',
      owner: 'samples',
      futureHeader: true,
      plugins: [
        { ...entry, id: 'samples.theme', release: { ...release, types: ['app-theme'] } },
        { ...entry, id: 'samples.broken', release: { ...release, commit: 'nope' } },
        { ...entry, release: { ...release, futureField: 1 }, futureField: 1 }
      ]
    })
    expect(marketplace).toEqual({ name: 'New', owner: 'samples', plugins: [{ ...entry, release }] })
  })

  it('rejects duplicate ids even when one copy is unreadable', () => {
    expect(() =>
      parse(PLUGIN_MARKETPLACE_V2_FILENAME, {
        name: 'New',
        owner: 'samples',
        plugins: [
          { ...entry, release },
          { ...entry, release: { ...release, commit: 'nope' } }
        ]
      })
    ).toThrow('duplicate plugin id')
  })

  it('keeps release entries out of the frozen v1 file', () => {
    expect(() =>
      parse(PLUGIN_MARKETPLACE_FILENAME, {
        name: 'Old',
        owner: 'samples',
        plugins: [{ ...entry, release }]
      })
    ).toThrow(`invalid ${PLUGIN_MARKETPLACE_FILENAME}`)
  })
})
