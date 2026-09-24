import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const readProject = (file) => readFileSync(join(projectDir, file), 'utf8')
const xtermManifest = JSON.parse(readProject('config/patches/xterm-upstream.json'))
const readInstalled = (name, file) =>
  readFileSync(join(resolve(require.resolve(`${name}/package.json`), '..'), file), 'utf8')

describe('vendored xterm WebGL runtime contract', () => {
  it('keeps shared WebGL atlas invalidation per renderer', () => {
    // Orca panes with the same font share one atlas, so a page merge or a clear in one
    // pane invalidates cached texture coords in all of them. Recovery has to be observed
    // per renderer: a consume-once flag lets whichever pane draws first eat the
    // notification and leaves its siblings drawing from a stale model.
    //
    // Upstream owns this since addon-webgl 0.20.0-beta.299, as a monotonic
    // pageLayoutVersion each renderer latches independently, so it is no longer something
    // Orca patches in. Assert it on the resolved dependency rather than on the patch.
    const atlas = readInstalled('@xterm/addon-webgl', 'src/TextureAtlas.ts')
    expect(atlas).toContain('public get pageLayoutVersion(): number')
    expect(atlas).toContain('this._pageLayoutVersion++')

    const glyphRenderer = readInstalled('@xterm/addon-webgl', 'src/GlyphRenderer.ts')
    expect(glyphRenderer).toContain(
      'this._atlas.pageLayoutVersion !== this._lastSeenPageLayoutVersion'
    )

    // Both shipped bundles have to carry it, not just the source beside them.
    for (const bundle of ['lib/addon-webgl.js', 'lib/addon-webgl.mjs']) {
      const contents = readInstalled('@xterm/addon-webgl', bundle)
      expect(contents, bundle).toContain('pageLayoutVersion')
      expect(contents, bundle).toContain('_lastSeenPageLayoutVersion')
    }
  })

  it('evicts one invisible glyph at a time instead of wiping the cache', () => {
    const webgl = xtermManifest.packages.find((entry) => entry.name === '@xterm/addon-webgl')
    for (const source of [
      readProject(webgl.sourcePatch),
      readInstalled('@xterm/addon-webgl', 'src/TextureAtlas.ts')
    ]) {
      // Invisible glyphs are keyed on their own, so admitting one never disturbs visible entries.
      expect(source).toContain('this._emptyGlyphKeys.has(emptyKey)')
      expect(source).toContain('this._emptyGlyphKeys.size >= Constants.EMPTY_GLYPH_CACHE_LIMIT')

      // Overflow drops the single oldest admission. A clear-all here made every workload that
      // stays above the cap re-rasterize all 4096 entries on each limit-th miss, and each of
      // those misses is a canvas draw plus a getImageData readback on the renderer thread.
      const overflow = source.slice(
        source.indexOf('this._emptyGlyphKeys.size >= Constants.EMPTY_GLYPH_CACHE_LIMIT'),
        source.indexOf('this._emptyGlyphKeys.add(emptyKey)')
      )
      expect(overflow).toContain('this._emptyGlyphKeys.delete(oldest)')
      expect(overflow).not.toContain('.clear()')
    }
    for (const bundle of ['lib/addon-webgl.js', 'lib/addon-webgl.mjs']) {
      const contents = readInstalled('@xterm/addon-webgl', bundle)
      expect(contents, bundle).toContain('_emptyGlyphKeys')
      expect(contents, bundle).toMatch(/_emptyGlyphKeys\.size>=4096/)
    }
  })

  it('serves a repeated invisible variant from cache and re-rasterizes an evicted one', () => {
    // A functional check of the eviction policy itself, run against the shipped bundle's own
    // constant rather than a copy of it. The atlas needs a GPU context, so the browser-backed
    // audit covers the real class; this pins the policy that makes the string checks meaningful.
    const limit = Number(
      readInstalled('@xterm/addon-webgl', 'lib/addon-webgl.js').match(
        /_emptyGlyphKeys\.size>=(\d+)/
      )?.[1]
    )
    expect(limit).toBe(4096)

    const keys = new Set()
    let rasterizations = 0
    const admit = (key) => {
      if (keys.has(key)) {
        return
      }
      rasterizations++
      if (keys.size >= limit) {
        for (const oldest of keys) {
          keys.delete(oldest)
          break
        }
      }
      keys.add(key)
    }

    for (let index = 0; index < limit * 3; index++) {
      admit(index)
    }
    expect(keys.size).toBe(limit)
    rasterizations = 0

    // Everything admitted since the cap was last exceeded is still resident, so a redraw of any
    // of them is free. Clear-all eviction would have left at most the entries since the last wipe.
    for (let index = limit * 2; index < limit * 3; index++) {
      admit(index)
    }
    expect(rasterizations).toBe(0)

    // Only the oldest admission is gone, and only it pays to be drawn again.
    admit(limit * 2 - 1)
    expect(rasterizations).toBe(1)
  })

  it('keeps the Orca-only WebGL hunks in the generated patch', () => {
    const webgl = xtermManifest.packages.find((entry) => entry.name === '@xterm/addon-webgl')
    const patch = readProject(webgl.patch)

    // A v_texpage past the sampler budget must resolve to a defined colour.
    expect(patch).toContain('else { outColor = vec4(0.0, 0.0, 0.0, 0.0); }')
    // clearTexture must not no-op once a merged page occupies index 0.
    expect(patch).toContain('this._pages.every(page => page.glyphs.length === 0')
    // The merge retry budget is spent before beginFrame latches the version it saw.
    expect(patch).toContain(
      'mergeRetries++ < Constants.MERGE_RETRY_LIMIT && this._glyphRenderer.value.beginFrame()'
    )
  })
})
