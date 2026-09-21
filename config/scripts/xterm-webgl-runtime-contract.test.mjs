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
