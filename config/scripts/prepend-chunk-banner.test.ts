import { describe, expect, it } from 'vitest'
import { prependChunkBanner } from '../build-plugins/prepend-chunk-banner'

const MAPPINGS = 'AAAA,IAAI;AACA'

type Chunk = { type: 'chunk'; code: string; fileName: string; sourcemapFileName: string | null }
type Asset = { type: 'asset'; fileName: string; source: string }

function createBundle(withMap: boolean): { bundle: Record<string, Chunk | Asset>; chunk: Chunk } {
  const chunk: Chunk = {
    type: 'chunk',
    code: 'const a = 1\nconst b = 2\n',
    fileName: 'index.js',
    sourcemapFileName: withMap ? 'index.js.map' : null
  }
  const bundle: Record<string, Chunk | Asset> = { 'index.js': chunk }
  if (withMap) {
    bundle['index.js.map'] = {
      type: 'asset',
      fileName: 'index.js.map',
      source: JSON.stringify({ version: 3, sources: ['index.ts'], mappings: MAPPINGS })
    }
  }
  return { bundle, chunk }
}

function mappingsOf(bundle: Record<string, Chunk | Asset>): string {
  const asset = bundle['index.js.map']
  if (asset?.type !== 'asset') {
    throw new Error('no map asset')
  }
  return JSON.parse(asset.source).mappings
}

describe('prependChunkBanner', () => {
  it('moves every mapping down by the lines the banner adds', () => {
    const { bundle, chunk } = createBundle(true)
    const banner = '\n;(() => {\n  guard()\n})();\n'

    prependChunkBanner(bundle, chunk, banner)

    expect(chunk.code).toBe(`${banner}const a = 1\nconst b = 2\n`)
    // Why: generated line 4 is `const a = 1` now, so its segments must sit after four empty lines.
    expect(mappingsOf(bundle)).toBe(`;;;;${MAPPINGS}`)
    expect(mappingsOf(bundle).split(';')[chunk.code.split('\n').indexOf('const a = 1')]).toBe(
      'AAAA,IAAI'
    )
  })

  it('prepends to a chunk that has no map', () => {
    const { bundle, chunk } = createBundle(false)

    prependChunkBanner(bundle, chunk, '// banner\n')

    expect(chunk.code).toBe('// banner\nconst a = 1\nconst b = 2\n')
    expect(Object.keys(bundle)).toEqual(['index.js'])
  })

  it('refuses a banner that ends mid-line', () => {
    const { bundle, chunk } = createBundle(true)

    expect(() => prependChunkBanner(bundle, chunk, '// banner')).toThrow(/must end with a newline/)
    expect(mappingsOf(bundle)).toBe(MAPPINGS)
  })
})
