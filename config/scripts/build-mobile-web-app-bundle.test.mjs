import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  withScratch,
  readAppBundle,
  readWrittenBundle,
  copyWrittenBundle
} from './mobile-web-app/mobile-web-app-bundle-test-fixture.mjs'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  bundleMobileWebApp,
  buildMobileWebAppBundle,
  entryStaticClosure,
  renameOutputsByContent,
  routeChunkNames
} from './build-mobile-web-app-bundle.mjs'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  collectMobileWebAppRouteKeys
} from './mobile-web-app/mobile-web-app-route-manifest.mjs'
import {
  MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES,
  MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES,
  MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD,
  MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN,
  MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP,
  MOBILE_WEB_APP_SOURCE_DIRS,
  assertAssetCeilingFitsShell,
  mobileWebAppBundleMaxAssets,
  mobileWebAppBundleBudgetBytes,
  mobileWebAppBundleMaxChunks,
  readMobileWebBundleMaxAssets,
  verifyMobileWebAppBundle
} from './verify-mobile-web-app-bundle.mjs'
import {
  BINARY_SOURCE_EXTENSIONS,
  assertNoCarriageReturnsInSource
} from './mobile-web-source-line-endings.mjs'
import {
  hashedAsset,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'
import {
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_ASSETS
} from '../../src/shared/mobile-web-bundle/manifest-contract.js'
import { mobileWebAppDependenciesPresent } from './mobile-web-app/mobile-web-app-bundle-dependencies.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

// The sharded `test` job does not install mobile dependencies, so anything that runs esbuild over
// the route tree is skipped there and run for real in pr.yml's mobile_web_app job.
const bundles = mobileWebAppDependenciesPresent()
const describeBundling = bundles ? describe : describe.skip
const itBundling = bundles ? it : it.skip

/** Every script the page loads. A route's code is in a chunk now, not in the entry. */
function allScriptSource({ script, chunks }) {
  return [script, ...chunks.map((chunk) => chunk.bytes)].map((bytes) => bytes.toString('utf8'))
}

describe('the CRLF pin', () => {
  it('exempts the same extensions in .gitattributes as the CRLF scan skips', async () => {
    const attributes = await readFile(join(projectDir, '.gitattributes'), 'utf8')
    for (const tree of MOBILE_WEB_APP_SOURCE_DIRS) {
      const pattern = `/${relative(projectDir, tree).split('\\').join('/')}/**`
      for (const extension of BINARY_SOURCE_EXTENSIONS) {
        // Without the exemption the blanket `text eol=lf` pin above it rewrites the binary and
        // every asset hash with it.
        expect(attributes, `${pattern}/*${extension} is not exempt`).toContain(
          `${pattern}/*${extension} -text`
        )
      }
    }
  })
})

describeBundling('the app bundle', () => {
  it('resolves react-native to react-native-web and leaves no require.context', async () => {
    const sources = allScriptSource(await readAppBundle())
    for (const source of sources) {
      expect(source).not.toContain('require.context')
    }
    // react-native-web's touch responder is proof the alias resolved rather than the native stub.
    expect(sources.some((source) => source.includes('ResponderTouchHistoryStore'))).toBe(true)
  }, 120_000)

  it('cuts the routes into chunks the entry does not load', async () => {
    const { script, chunks, entryStaticBytes } = await readAppBundle()
    expect(chunks.length).toBeGreaterThan(1)
    // The entry's own bytes plus the chunks it imports statically, which is what the browser
    // parses before any route paints. Every route chunk is outside it.
    expect(entryStaticBytes).toBeGreaterThan(script.byteLength)
    const allBytes =
      script.byteLength + chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0)
    expect(entryStaticBytes).toBeLessThan(allBytes)
  }, 120_000)

  it('names the chunk each route lands in', async () => {
    const { chunks, routeChunks, routeKeys } = await readAppBundle()
    expect(Object.keys(routeChunks).sort()).toEqual([...routeKeys].sort())
    const emitted = new Set(chunks.map((chunk) => chunk.name))
    for (const [key, name] of Object.entries(routeChunks)) {
      expect(emitted, key).toContain(name)
    }
    // One chunk per route, never the entry: that is what a client-side navigation fetches.
    expect(new Set(Object.values(routeChunks)).size).toBe(routeKeys.length)
  }, 120_000)

  it('counts only static imports into what loads before the first route', () => {
    const metafile = {
      outputs: {
        'dist/entry.js': {
          bytes: 10,
          imports: [
            { path: 'dist/shared.js', kind: 'import-statement' },
            { path: 'dist/route.js', kind: 'dynamic-import' }
          ]
        },
        'dist/shared.js': {
          bytes: 20,
          imports: [{ path: 'dist/deep.js', kind: 'import-statement' }]
        },
        'dist/deep.js': { bytes: 30, imports: [] },
        'dist/route.js': { bytes: 40, imports: [] }
      }
    }
    expect([...entryStaticClosure(metafile, 'dist/entry.js')]).toEqual([
      'dist/entry.js',
      'dist/shared.js',
      'dist/deep.js'
    ])
  })

  it('does not walk a chunk cycle forever', () => {
    const metafile = {
      outputs: {
        'dist/entry.js': { bytes: 1, imports: [{ path: 'dist/a.js', kind: 'import-statement' }] },
        'dist/a.js': { bytes: 1, imports: [{ path: 'dist/entry.js', kind: 'import-statement' }] }
      }
    }
    expect(entryStaticClosure(metafile, 'dist/entry.js').size).toBe(2)
  })

  itBundling(
    'refuses to build a route the lazy manifest would strip an export from',
    async () => {
      await withScratch(async (scratch) => {
        const directory = join(scratch, MOBILE_WEB_APP_ROUTE_ROOT)
        await mkdir(directory, { recursive: true })
        await writeFile(
          join(directory, 'index.tsx'),
          'export default function Route() { return null }\n'
        )
        await expect(bundleMobileWebApp({ appDir: scratch })).resolves.toBeTruthy()
        await writeFile(
          join(directory, 'settings.tsx'),
          'const anchor = { anchor: "index" }\nexport { anchor as unstable_settings }\nexport default function Route() { return null }\n'
        )
        // The build is where this has to fail: the page it would otherwise emit mounts with the
        // export silently gone, which is a blank screen on a phone and nothing in any log.
        await expect(bundleMobileWebApp({ appDir: scratch })).rejects.toThrow(
          /settings\.tsx.*unstable_settings/s
        )
      })
    },
    240_000
  )

  itBundling(
    'refuses a route whose star re-export it cannot read',
    async () => {
      await withScratch(async (scratch) => {
        const directory = join(scratch, MOBILE_WEB_APP_ROUTE_ROOT)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'boundary.ts'), 'export const value = 1\n')
        await writeFile(
          join(directory, 'index.tsx'),
          'export * from "./boundary"\nexport default function Route() { return null }\n'
        )
        await expect(bundleMobileWebApp({ appDir: scratch })).rejects.toThrow(
          /index\.tsx.*boundary/s
        )
      })
    },
    240_000
  )

  it('bundles every route module', async () => {
    const { routeKeys } = await readAppBundle()
    expect(routeKeys).toEqual(await collectMobileWebAppRouteKeys(appDir))
  }, 120_000)

  it("bundles a route's .web.tsx sibling instead of the native file, changing the bytes", async () => {
    await withScratch(async (scratch) => {
      const directory = join(scratch, MOBILE_WEB_APP_ROUTE_ROOT)
      await mkdir(directory, { recursive: true })
      const route = (marker) => `export default function Route() { return '${marker}' }\n`
      await writeFile(join(directory, 'index.tsx'), route('native-route-marker'))
      const before = await bundleMobileWebApp({ appDir: scratch })
      const has = (bundle, marker) =>
        allScriptSource(bundle).some((source) => source.includes(marker))
      expect(has(before, 'native-route-marker')).toBe(true)

      await writeFile(join(directory, 'index.web.tsx'), route('web-route-marker'))
      const after = await bundleMobileWebApp({ appDir: scratch })
      expect(has(after, 'web-route-marker')).toBe(true)
      expect(has(after, 'native-route-marker')).toBe(false)
      // Different script bytes means a different asset sha and so a different buildId.
      expect(after.script.equals(before.script)).toBe(false)
    })
  }, 240_000)

  /**
   * The same route tree, bundled from two directories at different depths. esbuild's own `[hash]`
   * is computed over the metafile's input keys, which are paths relative to absWorkingDir, so two
   * checkouts of one commit -- at different depths, or one with mobile/node_modules as a symlink
   * and one with it as a directory -- name a byte-identical chunk differently. The rename
   * cascades through every importer into a different buildId, and every phone re-downloads a
   * bundle whose bytes did not change.
   */
  async function bundleFromDepth(root, depth) {
    const nested = join(root, ...Array.from({ length: depth }, (_, index) => `d${String(index)}`))
    const directory = join(nested, MOBILE_WEB_APP_ROUTE_ROOT)
    await mkdir(directory, { recursive: true })
    // Two routes over one import, which is what makes esbuild emit a shared chunk to name.
    await writeFile(join(directory, 'shared.ts'), 'export const marker = "shared-marker"\n')
    for (const name of ['index.tsx', 'other.tsx']) {
      await writeFile(
        join(directory, name),
        `import { marker } from "./shared"\nexport default function Route() { return marker + "${name}" }\n`
      )
    }
    return { appDir: nested, bundle: await bundleMobileWebApp({ appDir: nested }) }
  }

  it('names every output by its bytes, so another checkout path builds the same bundle', async () => {
    await withScratch(async (shallow) => {
      await withScratch(async (deep) => {
        const near = await bundleFromDepth(shallow, 1)
        const far = await bundleFromDepth(deep, 5)
        const names = ({ bundle }) => [...bundle.chunks, ...bundle.images].map((one) => one.name)
        expect(names(far)).toEqual(names(near))
        expect(far.bundle.script.equals(near.bundle.script)).toBe(true)
        // The whole point: the manifest the phone compares is the same document.
        const buildIdFrom = async ({ appDir }) =>
          withScratch(async (out) => {
            const { manifest } = await buildMobileWebAppBundle({
              appDir,
              outDir: join(out, 'x'),
              // A synthetic tree: the real declarations name screens it does not have.
              pageRoutes: []
            })
            return manifest.buildId
          })
        expect(await buildIdFrom(far)).toBe(await buildIdFrom(near))
      })
    })
  }, 240_000)

  it("names an output the same way the manifest's own asset hash does", async () => {
    const { script, chunks } = await readAppBundle()
    // The name is embedded in the importer, so it cannot be recomputed later; this is what says
    // the name inside the bytes and the manifest's sha256 of those bytes are the same string.
    expect(hashedAsset(script, 'js').path).toBe(`assets/${sha256Hex(script)}.js`)
    for (const chunk of chunks) {
      expect(chunk.name).toBe(`${sha256Hex(chunk.bytes)}.js`)
    }
  }, 120_000)

  it('ships no haptic that reaches for the DOM', async () => {
    // expo-haptics' web build fakes an iOS haptic by appending a hidden
    // `<label><input type="checkbox" switch>` to document.head, clicking it, and removing it —
    // once per call. The file explorer calls triggerSelection on every row tap, and C1.9 already
    // traced a swallowed long press on the worktree list to that stray click. `haptics.web.ts` is
    // what keeps the whole shim out of the bundle, so this reads the bytes rather than the import.
    for (const source of allScriptSource(await readAppBundle())) {
      // The shim's own fingerprint, not `navigator.vibrate`: react-native-web's Vibration export
      // calls that too, and it touches no DOM until something invokes it.
      expect(source).not.toContain('ariaHidden')
      expect(source).not.toContain('pointer: coarse')
      expect(source).not.toContain('setAttribute("switch"')
    }
  }, 120_000)

  it("ships react-native-web's hairline at one device pixel, whichever of its builds resolves", async () => {
    const sources = allScriptSource(await readAppBundle())
    // Minified, so the assignment reads `<name>.hairlineWidth=`; RNW's own value is the literal 1.
    const assignments = sources.flatMap(
      (source) => source.match(/\.hairlineWidth=[^;]{0,120}/g) ?? []
    )
    expect(assignments.length).toBeGreaterThan(0)
    for (const assignment of assignments) {
      expect(assignment).toContain('devicePixelRatio')
    }
  }, 120_000)

  it('embeds no absolute path from this checkout', async () => {
    // Every chunk, not only the entry: the route manifest names each route by absolute path, and
    // the chunk that import resolves to is where such a path would survive.
    for (const source of allScriptSource(await readAppBundle())) {
      expect(source).not.toContain(projectDir)
    }
  }, 120_000)

  it('builds the same buildId twice', async () => {
    const first = await withScratch((scratch) =>
      buildMobileWebAppBundle({ outDir: join(scratch, 'a') })
    )
    const second = await withScratch((scratch) =>
      buildMobileWebAppBundle({ outDir: join(scratch, 'b') })
    )
    expect(first.manifest.buildId).toBe(second.manifest.buildId)
  }, 120_000)

  it('loads the entry as a module, so its route imports resolve', async () => {
    const { manifest, html } = await readWrittenBundle()
    // import() in a classic script is a syntax error, so the tag and the format are one fact.
    expect(html).toContain('<script type="module" src="/assets/')
    const entry = html.match(/src="\/(assets\/[^"]+)"/)?.[1]
    expect(manifest.assets.map((asset) => asset.path)).toContain(entry)
  }, 120_000)

  it('declares an icon, so no browser asks the shell for one', async () => {
    const { manifest, html } = await readWrittenBundle()
    // Undeclared, a browser asks the origin for /favicon.ico on its own, and the shell's asset
    // server answers 403 because the path is in no manifest — repeatedly, on the emulator run.
    expect(html).toContain('<link rel="icon" href="data:," />')
    // And the empty URI rather than an asset: the bundle carries no icon, so a declaration
    // naming one would point at a route image whose name changes with its bytes.
    expect(manifest.assets.map((asset) => asset.path)).not.toContain('favicon.ico')
  }, 120_000)

  it('declares no viewport-fit, because the shell owns the safe area', async () => {
    const { html } = await readWrittenBundle()
    // The shell pads the WebView out of the system bars, so the page has nothing to extend
    // under; asking to would invite a second pad from every page-side SafeAreaView.
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />')
    expect(html).not.toContain('viewport-fit')
  }, 120_000)

  it('carries the root reset, so the mounted tree has a height to be 1 of', async () => {
    const { html } = await readWrittenBundle()
    expect(html).toContain(MOBILE_WEB_APP_ROOT_RESET)
    expect(html).toContain(MOBILE_WEB_APP_NATIVE_PARITY_STYLE)
    // Literals rather than substrings taken off the constant, which would read it back against
    // itself and follow any rule dropped from it. Every rule, because the chain is only as
    // definite as its weakest link: a height on #root alone resolves against a body that has
    // none, and percent of auto is auto. Named one by one so a failure says which rule went.
    for (const rule of [
      'html,body{height:100%}',
      'body{overflow:hidden}',
      '#root{display:flex;height:100%;flex:1}'
    ]) {
      expect(MOBILE_WEB_APP_ROOT_RESET, rule).toContain(rule)
    }
    // The id travels with the rules: it is what marks this block as the template's reset rather
    // than something the page grew its own copy of.
    expect(MOBILE_WEB_APP_ROOT_RESET).toContain('<style id="expo-reset">')
    // In the document itself, not a linked asset: the CSP that allows it is the one already
    // relaxed for react-native-web's runtime sheet.
    expect(html).not.toContain('<link rel="stylesheet"')
  }, 120_000)

  it('writes the manifest shape the packaging contract reads', async () => {
    const { manifest } = await readWrittenBundle()
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.entrypoint).toBe('index.html')
    expect(manifest.assets.map((asset) => asset.path)).toContain('index.html')
    expect(manifest.totalBytes).toBe(
      manifest.assets.reduce((total, asset) => total + asset.byteLength, 0)
    )
  }, 120_000)
})

describe('the Phase C budget', () => {
  it('reserves the font allowance only for the exact licensed symbol asset', async () => {
    const font = hashedAsset(
      await readFile(join(projectDir, 'mobile/assets/fonts/SymbolsNerdFontMono-Regular.woff2')),
      'woff2'
    )
    const manifest = { totalBytes: font.byteLength + 123, assets: [font] }
    expect(mobileWebAppBundleBudgetBytes(manifest)).toBe(123)
    expect(
      mobileWebAppBundleBudgetBytes({
        ...manifest,
        totalBytes: font.byteLength + MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES + 1
      })
    ).toBeGreaterThan(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)
    expect(mobileWebAppBundleBudgetBytes({ totalBytes: 123, assets: [] })).toBe(123)
    for (const change of [
      { path: 'assets/another.woff2' },
      { sha256: 'a'.repeat(64) },
      { contentType: 'text/javascript' },
      { byteLength: font.byteLength + 1 }
    ]) {
      expect(() =>
        mobileWebAppBundleBudgetBytes({ ...manifest, assets: [{ ...font, ...change }] })
      ).toThrow(/approved hash, path, MIME type and bounded byte length/)
    }
    expect(() => mobileWebAppBundleBudgetBytes({ ...manifest, assets: [font, font] })).toThrow(
      /only one licensed terminal font/
    )
    expect(
      mobileWebAppBundleBudgetBytes({
        totalBytes: font.byteLength,
        assets: [{ ...font, path: 'assets/code.js', contentType: 'text/javascript' }]
      })
    ).toBe(font.byteLength)
  })

  it('sits below the contract per-asset ceiling, so growth trips a build not a phone', () => {
    expect(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES).toBeLessThan(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES)
  })

  itBundling(
    'is not already exceeded by the current bundle',
    async () => {
      const { manifest, chunkCount, entryStaticBytes, imageCount, routeKeys } =
        await readWrittenBundle()
      expect(mobileWebAppBundleBudgetBytes(manifest)).toBeLessThanOrEqual(
        MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES
      )
      expect(manifest.assets.length).toBeLessThanOrEqual(
        mobileWebAppBundleMaxAssets(routeKeys.length, imageCount)
      )
      expect(chunkCount).toBeLessThanOrEqual(mobileWebAppBundleMaxChunks(routeKeys.length))
      // The other side of the same fence: an envelope further than the margin above the build is
      // one nobody re-derived, so it fails here rather than surviving as headroom for a bump.
      expect(
        mobileWebAppBundleMaxChunks(routeKeys.length) - chunkCount,
        'the chunk envelope is looser than this build; re-measure MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP'
      ).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN)
      expect(entryStaticBytes).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES)
    },
    120_000
  )

  it('budgets what loads first well under what the whole page weighs', () => {
    // The point of the split: the entry budget is the one a route must not grow, and it is a
    // fraction of the total the bundle is still allowed to weigh.
    expect(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES).toBeLessThan(
      MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES
    )
  })

  itBundling('sweeps the tree the envelope is anchored on', async () => {
    // The sweep is the fence's only input, so it has to be about this tree: a route added anywhere
    // in the sorted list fails here, which is the re-measure the plan asks for instead of a bump.
    expect(MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.map(([key]) => key)).toEqual(
      await collectMobileWebAppRouteKeys(join(projectDir, 'mobile', 'app'))
    )
  })

  it('bounds every prefix the sweep measured, and the spread it reports', () => {
    // An upper envelope of the measurement, not a fit: the count rises with the prefix, so the
    // number above its top row is above every row.
    for (const [key, measured] of MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP) {
      expect(
        mobileWebAppBundleMaxChunks(MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.length),
        key
      ).toBeGreaterThanOrEqual(measured)
    }
    // 1 to 14 per route, which is why four per route was a bound rather than a fit and why the
    // envelope cannot be a line through the measurement either.
    expect(Math.min(...MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD)).toBe(1)
    expect(Math.max(...MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD)).toBe(14)
  })

  it('sits exactly one margin over the swept tree and grants the worst route beyond it', () => {
    const swept = MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.length
    const measured = MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.at(-1)[1]
    expect(mobileWebAppBundleMaxChunks(swept)).toBe(measured + MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN)
    // Past the swept tree each route is allowed the worst the sweep saw, so the next route breaches
    // this only by costing more than any route measured.
    for (const beyond of [1, 2, 9]) {
      expect(mobileWebAppBundleMaxChunks(swept + beyond) - mobileWebAppBundleMaxChunks(swept)).toBe(
        Math.max(...MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD) * beyond
      )
    }
    // Flat below it: the fence is only ever asked about the real tree, and a shorter prefix is
    // already under the top row it is anchored on.
    expect(mobileWebAppBundleMaxChunks(swept - 1)).toBe(mobileWebAppBundleMaxChunks(swept))
  })

  it('refuses an engine chunked along its own lazy boundaries, and passes one artifact', () => {
    // The two builds the ceiling must tell apart: mermaid through one pre-bundled artifact
    // emitted 69 scripts, importing the package emitted 172, esbuild splitting along the diagram
    // types mermaid lazily imports. Both frozen at the head that measured them, because this case
    // pins the discrimination and not either build's size.
    //
    // 69 now sits just under the envelope: a sweep that falls further means re-measure, not raise.
    const ROUTES = 14
    const WITH_ONE_ARTIFACT = 69
    const CHUNKED_ALONG_THE_ENGINE = 172
    expect(WITH_ONE_ARTIFACT).toBeLessThanOrEqual(mobileWebAppBundleMaxChunks(ROUTES))
    expect(CHUNKED_ALONG_THE_ENGINE).toBeGreaterThan(mobileWebAppBundleMaxChunks(ROUTES))
    // And the assets that came with it: 215 against the 113 this head's envelope allows, of the
    // 256 the shell will load.
    expect(mobileWebAppBundleMaxAssets(ROUTES, 42)).toBeLessThan(CHUNKED_ALONG_THE_ENGINE + 42 + 1)
  })

  it('derives the asset ceiling so the chunk ceiling is always the one that trips first', () => {
    // A bundle's assets are its chunks, its images and the document. Asserting one constant under
    // another did not say that: with 42 images, the 98 chunks 18 routes are allowed plus 42 plus
    // the document is 141 assets, over the flat 128 the ceiling used to be, so from 18 routes on
    // the asset count failed first and named the wrong thing.
    for (const routeCount of [14, 18, 24, 40]) {
      for (const imageCount of [0, 42, 120]) {
        const chunks = mobileWebAppBundleMaxChunks(routeCount)
        expect(mobileWebAppBundleMaxAssets(routeCount, imageCount)).toBe(chunks + imageCount + 1)
        // The ordering claim itself: a bundle at the chunk ceiling is exactly at the asset
        // ceiling, so no bundle can pass the chunk check and fail the asset one.
        expect(chunks + imageCount + 1).toBeLessThanOrEqual(
          mobileWebAppBundleMaxAssets(routeCount, imageCount)
        )
      }
    }
  })

  itBundling(
    'keeps the derived ceiling under the map the phone actually holds',
    async () => {
      const { manifest, routeKeys, imageCount } = await readWrittenBundle()
      const ceiling = mobileWebAppBundleMaxAssets(routeKeys.length, imageCount)
      expect(manifest.assets.length).toBeLessThanOrEqual(ceiling)
      // The native side refuses a manifest past this, so the derived ceiling has to stay inside it.
      expect(ceiling).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_MAX_ASSETS)
      // And the build is what has to say so: the guard runs on the counts this bundle measured.
      const shellCeiling = await readMobileWebBundleMaxAssets()
      expect(assertAssetCeilingFitsShell(routeKeys.length, imageCount, shellCeiling)).toBe(ceiling)
    },
    120_000
  )

  it('fails the build when the derived ceiling passes what the phone will accept', async () => {
    // The shell hands back null for a manifest over its own ceiling, so a derived ceiling above
    // that ships a green build no device can open. At the 42 images the tree carries, the envelope
    // plus 42 plus the document crosses 256 at 25 routes, which Phase C reaches. The crossing came
    // in from 50 with the envelope: it grants the worst swept route to each one past the sweep,
    // where `4r + 16` granted four, so re-measuring a tree whose routes share more moves it out.
    expect(await readMobileWebBundleMaxAssets()).toBe(MOBILE_WEB_BUNDLE_MAX_ASSETS)
    expect(assertAssetCeilingFitsShell(24, 42, MOBILE_WEB_BUNDLE_MAX_ASSETS)).toBe(250)
    expect(() => assertAssetCeilingFitsShell(25, 42, MOBILE_WEB_BUNDLE_MAX_ASSETS)).toThrow(
      /264 .*256/
    )
  })
})

describe('the verifier', () => {
  itBundling(
    'accepts a bundle it has just built',
    async () => {
      await withScratch(async (scratch) => {
        const outDir = join(scratch, 'mobile-web')
        await copyWrittenBundle(outDir)
        await expect(verifyMobileWebAppBundle({ bundleDir: outDir })).resolves.toBeDefined()
      })
    },
    240_000
  )

  itBundling(
    "rejects a buildId the manifest's own asset list does not derive",
    async () => {
      await withScratch(async (scratch) => {
        const outDir = join(scratch, 'mobile-web')
        await copyWrittenBundle(outDir)
        const manifestPath = join(outDir, 'manifest.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.buildId = 'f'.repeat(64)
        await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
        await expect(verifyMobileWebAppBundle({ bundleDir: outDir })).rejects.toThrow(
          'does not match its asset list'
        )
      })
    },
    240_000
  )

  itBundling(
    'rejects a self-consistent bundle a fresh build does not reproduce',
    async () => {
      await withScratch(async (scratch) => {
        const outDir = join(scratch, 'mobile-web')
        const { manifest } = await copyWrittenBundle(outDir)
        // What a stale out/ actually looks like: every digest agrees with its bytes and the
        // buildId derives from the asset list, but the source has moved on. Only the two fresh
        // builds the verifier runs can tell, which is the check this covers.
        const assets = await Promise.all(
          manifest.assets.map(async (asset) => ({
            ...asset,
            bytes: await readFile(join(outDir, asset.path))
          }))
        )
        const document = assets.find((asset) => asset.path === manifest.entrypoint)
        document.bytes = Buffer.concat([document.bytes, Buffer.from('<!-- drift -->\n', 'utf8')])
        document.sha256 = sha256Hex(document.bytes)
        document.byteLength = document.bytes.byteLength
        const [desktopVersion, protocolWindow] = await Promise.all([
          readDesktopVersion(),
          readProtocolWindow()
        ])
        await writeMobileWebBundleTree({ outDir, written: assets, desktopVersion, protocolWindow })

        await expect(verifyMobileWebAppBundle({ bundleDir: outDir })).rejects.toThrow('is stale')
      })
    },
    240_000
  )
})

describe('the CRLF guard', () => {
  it('covers the three trees whose bytes reach the buildId', () => {
    expect(MOBILE_WEB_APP_SOURCE_DIRS.map((dir) => dir.slice(projectDir.length))).toEqual([
      join('mobile', 'web-entry'),
      join('mobile', 'app'),
      join('mobile', 'src')
    ])
  })

  it('fails on a CRLF source file', async () => {
    await withScratch(async (scratch) => {
      await writeFile(join(scratch, 'route.tsx'), 'export default null\r\n', 'utf8')
      await expect(assertNoCarriageReturnsInSource(scratch)).rejects.toThrow('CRLF')
    })
  })

  it('exempts the binary assets .gitattributes pins -text', async () => {
    await withScratch(async (scratch) => {
      await writeFile(join(scratch, 'icon.ttf'), Buffer.from([0x00, 0x0d, 0x0a]))
      await writeFile(join(scratch, 'shot.png'), Buffer.from([0x0d]))
      await expect(assertNoCarriageReturnsInSource(scratch)).resolves.toBeUndefined()
    })
  })

  it('exempts the gitignored generated webview engine modules', async () => {
    await withScratch(async (scratch) => {
      await writeFile(join(scratch, 'engine.generated.ts'), 'export const X = "a\r\n"', 'utf8')
      await expect(assertNoCarriageReturnsInSource(scratch)).resolves.toBeUndefined()
    })
  })
})

describe('naming an output by its bytes', () => {
  it('refuses two outputs that name each other', () => {
    const emitted = (text) => new TextEncoder().encode(text)
    const metafile = {
      outputs: {
        'dist/a.js': { imports: [{ path: 'dist/b.js', kind: 'import-statement' }] },
        'dist/b.js': { imports: [{ path: 'dist/a.js', kind: 'import-statement' }] }
      }
    }
    // Neither name can be final before the other is, so a cycle has no content hash to reach.
    // esbuild's splitting emits a DAG; this is the hard stop for the day it does not.
    expect(() =>
      renameOutputsByContent(metafile, [
        { path: 'dist/a.js', contents: emitted('import "/assets/b.js"') },
        { path: 'dist/b.js', contents: emitted('import "/assets/a.js"') }
      ])
    ).toThrow(/output cycle/)
  })

  it('refuses a route it cannot find an output for', async () => {
    await withScratch(async (scratch) => {
      const module = join(scratch, 'index.tsx')
      await writeFile(module, 'export default function Route() { return null }\n')
      // The metafile is the only thing that knows which chunk holds a route. Without this the
      // route reaches the manifest naming a chunk of undefined, which the phone fetches as a 404.
      expect(() =>
        routeChunkNames({ outputs: {} }, [{ key: './index.tsx', module }], new Map())
      ).toThrow(/\.\/index\.tsx reached no output/)
    })
  })
})
