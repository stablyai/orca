import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
let ColorContrastCache

beforeAll(async () => {
  const root = dirname(require.resolve('@xterm/xterm/package.json'))
  const result = await build({
    entryPoints: [join(root, 'src/browser/ColorContrastCache.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  ;({ ColorContrastCache } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  ))
})

describe('vendored xterm contrast cache', () => {
  it('retains cached nulls and updates existing entries without spending capacity', () => {
    const cache = new ColorContrastCache()
    for (let index = 0; index < 4096; index++) {
      cache.setColor(0, index, null)
    }
    const corrected = { css: '#ffffff', rgba: 0xffffffff }
    for (let index = 0; index < 10000; index++) {
      cache.setColor(0, 4095, corrected)
    }
    expect(cache.getColor(0, 0)).toBeNull()
    expect(cache.getColor(0, 4095)).toBe(corrected)
  })

  it('bounds the combined color and CSS cache across distinct backgrounds', () => {
    const cache = new ColorContrastCache()
    for (let index = 0; index < 2048; index++) {
      cache.setColor(index, 0, null)
      cache.setCss(index, 1, '#ffffff')
    }
    expect(cache.getColor(0, 0)).toBeNull()
    expect(cache.getCss(0, 1)).toBe('#ffffff')
    cache.setCss(2048, 1, '#eeeeee')
    expect(cache.getColor(0, 0)).toBeUndefined()
    expect(cache.getCss(0, 1)).toBeUndefined()
    expect(cache.getCss(2048, 1)).toBe('#eeeeee')
  })

  it('counts a background/foreground pair once across both setters', () => {
    const cache = new ColorContrastCache()
    for (let index = 0; index < 4096; index++) {
      cache.setColor(index, 0, null)
      cache.setCss(index, 0, '#ffffff')
    }
    expect(cache.getColor(0, 0)).toBeNull()
    expect(cache.getCss(0, 0)).toBe('#ffffff')
    cache.setCss(4096, 0, '#eeeeee')
    expect(cache.getColor(0, 0)).toBeUndefined()
    expect(cache.getCss(0, 0)).toBeUndefined()
    expect(cache.getCss(4096, 0)).toBe('#eeeeee')
  })

  it('resets capacity after a theme clear and preserves independent terminal caches', () => {
    const cache = new ColorContrastCache()
    const sibling = new ColorContrastCache()
    sibling.setColor(0, 0, null)
    cache.setCss(0, 0, null)
    cache.clear()
    for (let index = 0; index < 4096; index++) {
      cache.setColor(0, index, null)
    }
    expect(cache.getColor(0, 0)).toBeNull()
    expect(cache.getCss(0, 0)).toBeUndefined()
    cache.setColor(0, 4096, null)
    expect(cache.getColor(0, 0)).toBeUndefined()
    expect(sibling.getColor(0, 0)).toBeNull()
  })
})
