import { describe, expect, it } from 'vitest'
import { PLUGIN_CATALOG_FILENAME } from '../../shared/plugins/plugin-catalog'
import { PLUGIN_MARKETPLACE_FILENAME } from '../../shared/plugins/plugin-marketplace'
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
  it('keeps valid catalog entries next to ones this client cannot install', () => {
    const marketplace = parse(PLUGIN_CATALOG_FILENAME, {
      catalogVersion: 2,
      name: 'New',
      owner: 'samples',
      futureHeader: true,
      plugins: [
        { ...entry, id: 'samples.theme', releases: [{ ...release, types: ['file-viewer'] }] },
        { ...entry, id: 'samples.broken', releases: [{ ...release, commit: 'nope' }] },
        { ...entry, releases: [{ ...release, futureField: 1 }], futureField: 1 }
      ]
    })
    expect(marketplace).toMatchObject({
      name: 'New',
      owner: 'samples',
      plugins: [{ ...entry, releases: [release] }]
    })
    expect(marketplace.plugins).toHaveLength(1)
  })

  it('keeps the first readable copy of a repeated id', () => {
    const marketplace = parse(PLUGIN_CATALOG_FILENAME, {
      catalogVersion: 2,
      name: 'New',
      owner: 'samples',
      plugins: [
        { ...entry, releases: [{ ...release, commit: 'nope' }] },
        { ...entry, description: 'first readable', releases: [release] },
        { ...entry, description: 'later copy', releases: [release] }
      ]
    })
    expect(marketplace.plugins.map((plugin) => plugin.description)).toEqual(['first readable'])
  })

  it('refuses a newer catalog format with the fix', () => {
    expect(() =>
      parse(PLUGIN_CATALOG_FILENAME, {
        catalogVersion: 3,
        name: 'New',
        owner: 'samples',
        plugins: []
      })
    ).toThrow('orca-catalog.json uses catalog format 3; update Orca to browse this catalog')
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
