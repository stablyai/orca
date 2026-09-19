import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_APP_ROOT_RESET,
  MOBILE_WEB_APP_SHIMS,
  bundleMobileWebApp,
  buildMobileWebAppBundle,
  entryStaticClosure,
  mobileWebAppBuildOptions,
  renameOutputsByContent,
  resolveMobileWebPageRoutes,
  routeChunkNames
} from './build-mobile-web-app-bundle.mjs'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  ROUTE_SOURCE_LOADERS,
  collectMobileWebAppRouteKeys,
  collectMobileWebAppRoutes,
  routePathnameFromKey
} from './mobile-web-app-route-manifest.mjs'
import {
  MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES,
  MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES,
  MOBILE_WEB_APP_SOURCE_DIRS,
  assertAssetCeilingFitsShell,
  mobileWebAppBundleMaxAssets,
  mobileWebAppBundleMaxChunks,
  readMobileWebBundleMaxAssets,
  verifyMobileWebAppBundle
} from './verify-mobile-web-app-bundle.mjs'
import {
  BINARY_SOURCE_EXTENSIONS,
  assertNoCarriageReturnsInSource
} from './verify-mobile-web-bundle.mjs'
import {
  computeMobileWebBundleBuildId,
  hashedAsset,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './build-mobile-web-bundle.mjs'
import {
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_ASSETS
} from '../../src/shared/mobile-web-bundle/manifest-contract.js'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

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

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-test-'))
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

describe('the page routes the manifest declares', () => {
  it('turns a route key into the URL pattern expo-router gives it', () => {
    expect(routePathnameFromKey('./h/[hostId]/index.tsx')).toBe('/h/[hostId]')
    expect(routePathnameFromKey('./h/[hostId]/tasks.tsx')).toBe('/h/[hostId]/tasks')
    expect(routePathnameFromKey('./h/[hostId]/session/[worktreeId].tsx')).toBe(
      '/h/[hostId]/session/[worktreeId]'
    )
  })

  it('answers null for a layout, which is not a screen anyone navigates to', () => {
    expect(routePathnameFromKey('./h/_layout.tsx')).toBeNull()
    expect(routePathnameFromKey('./h/[hostId]/_layout.tsx')).toBeNull()
  })

  it('declares only routes the bundle has a module for', async () => {
    const keys = await collectMobileWebAppRouteKeys(appDir)
    expect(resolveMobileWebPageRoutes(keys)).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate', 'storage'] },
      { pathname: '/h/[hostId]/agent-history/[worktreeId]', grants: ['navigate', 'storage'] }
    ])
  })

  it('fails the build on a declaration the bundle cannot render', () => {
    // The mismatch reaches a phone as a route the shell opens the page for and the page then
    // paints as Unmatched. This is the only place whoever wrote the declaration can see it.
    expect(() =>
      resolveMobileWebPageRoutes(
        ['./h/[hostId]/index.tsx'],
        [{ pathname: '/h/[hostId]/gone', grants: [] }]
      )
    ).toThrow('has no module in the bundle')
  })

  itBundling(
    'reaches the built manifest, where the build id does not move for it',
    async () => {
      await withScratch(async (scratch) => {
        const { manifest } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
        expect(manifest.routes).toEqual([
          { pathname: '/h/[hostId]', grants: ['navigate', 'storage'] },
          { pathname: '/h/[hostId]/agent-history/[worktreeId]', grants: ['navigate', 'storage'] }
        ])
        // The routes are derived from the same tree the script is built from, so the assets
        // already decide them and the id has no reason to carry them as well.
        expect(manifest.buildId).toBe(computeMobileWebBundleBuildId(manifest.assets))
      })
    },
    240_000
  )
})

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
    const sources = allScriptSource(await bundleMobileWebApp())
    for (const source of sources) {
      expect(source).not.toContain('require.context')
    }
    // react-native-web's touch responder is proof the alias resolved rather than the native stub.
    expect(sources.some((source) => source.includes('ResponderTouchHistoryStore'))).toBe(true)
  }, 120_000)

  it('cuts the routes into chunks the entry does not load', async () => {
    const { script, chunks, entryStaticBytes } = await bundleMobileWebApp()
    expect(chunks.length).toBeGreaterThan(1)
    // The entry's own bytes plus the chunks it imports statically, which is what the browser
    // parses before any route paints. Every route chunk is outside it.
    expect(entryStaticBytes).toBeGreaterThan(script.byteLength)
    const allBytes =
      script.byteLength + chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0)
    expect(entryStaticBytes).toBeLessThan(allBytes)
  }, 120_000)

  it('names the chunk each route lands in', async () => {
    const { chunks, routeChunks, routeKeys } = await bundleMobileWebApp()
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
    const { routeKeys } = await bundleMobileWebApp()
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
    const { script, chunks } = await bundleMobileWebApp()
    // The name is embedded in the importer, so it cannot be recomputed later; this is what says
    // the name inside the bytes and the manifest's sha256 of those bytes are the same string.
    expect(hashedAsset(script, 'js').path).toBe(`assets/${sha256Hex(script)}.js`)
    for (const chunk of chunks) {
      expect(chunk.name).toBe(`${sha256Hex(chunk.bytes)}.js`)
    }
  }, 120_000)

  it('asks esbuild for the split the budgets assume', async () => {
    const options = mobileWebAppBuildOptions(await collectMobileWebAppRoutes(appDir))
    // Each of these is load-bearing for a budget below: esm and splitting are what make a route a
    // chunk, and the metafile is the only thing that says which imports are static.
    expect(options.format).toBe('esm')
    expect(options.splitting).toBe(true)
    expect(options.chunkNames).toBe('[hash]')
    expect(options.metafile).toBe(true)
  })

  it('reads a route source the same way the export guard does', async () => {
    const options = mobileWebAppBuildOptions(await collectMobileWebAppRoutes(appDir))
    // The guard parses each route on its own, outside this build. Sharing the table is what stops
    // a loader the bundle relies on from being missing there and reported as a syntax error.
    for (const [extension, loader] of Object.entries(ROUTE_SOURCE_LOADERS)) {
      expect(options.loader[extension], extension).toBe(loader)
    }
  })

  it('applies every shim it names', async () => {
    const options = mobileWebAppBuildOptions(await collectMobileWebAppRoutes(appDir))
    for (const shim of MOBILE_WEB_APP_SHIMS) {
      expect(shim.appliesTo(options), `${shim.name} is named but not applied`).toBe(true)
    }
  })

  it('fails the named shim, not the whole build, when its option goes missing', async () => {
    const options = mobileWebAppBuildOptions(await collectMobileWebAppRoutes(appDir))
    // Each shim reads a different option, so removing one leaves the other five true. Without
    // that, the list could name a shim the build stopped applying.
    const stripped = {
      ...options,
      alias: {},
      loader: {},
      define: {},
      banner: {},
      plugins: []
    }
    expect(MOBILE_WEB_APP_SHIMS.filter((shim) => shim.appliesTo(stripped))).toEqual([])
  })

  it('keeps the shims out of the shipped Phase A bootstrap builder', async () => {
    const shipped = await readFile(
      join(projectDir, 'config', 'scripts', 'build-mobile-web-bundle.mjs'),
      'utf8'
    )
    for (const { name } of MOBILE_WEB_APP_SHIMS) {
      expect(shipped, `the Phase A bootstrap builder mentions ${name}`).not.toContain(name)
    }
    expect(shipped).not.toContain('react-native-web')
    expect(shipped).not.toContain('lucide')
  })

  it('embeds no absolute path from this checkout', async () => {
    // Every chunk, not only the entry: the route manifest names each route by absolute path, and
    // the chunk that import resolves to is where such a path would survive.
    for (const source of allScriptSource(await bundleMobileWebApp())) {
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
    await withScratch(async (scratch) => {
      const outDir = join(scratch, 'module-tag')
      const { manifest } = await buildMobileWebAppBundle({ outDir })
      const html = await readFile(join(outDir, 'index.html'), 'utf8')
      // import() in a classic script is a syntax error, so the tag and the format are one fact.
      expect(html).toContain('<script type="module" src="/assets/')
      const entry = html.match(/src="\/(assets\/[^"]+)"/)?.[1]
      expect(manifest.assets.map((asset) => asset.path)).toContain(entry)
    })
  }, 120_000)

  it('carries the root reset, so the mounted tree has a height to be 1 of', async () => {
    await withScratch(async (scratch) => {
      const outDir = join(scratch, 'root-reset')
      await buildMobileWebAppBundle({ outDir })
      const html = await readFile(join(outDir, 'index.html'), 'utf8')
      expect(html).toContain(MOBILE_WEB_APP_ROOT_RESET)
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
    })
  }, 120_000)

  it('writes the manifest shape the packaging contract reads', async () => {
    const { manifest } = await withScratch((scratch) =>
      buildMobileWebAppBundle({ outDir: join(scratch, 'c') })
    )
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.entrypoint).toBe('index.html')
    expect(manifest.assets.map((asset) => asset.path)).toContain('index.html')
    expect(manifest.totalBytes).toBe(
      manifest.assets.reduce((total, asset) => total + asset.byteLength, 0)
    )
  }, 120_000)
})

describe('the Phase C budget', () => {
  it('sits below the contract per-asset ceiling, so growth trips a build not a phone', () => {
    expect(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES).toBeLessThan(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES)
  })

  itBundling(
    'is not already exceeded by the current bundle',
    async () => {
      const { manifest, chunkCount, entryStaticBytes, imageCount, routeKeys } = await withScratch(
        (scratch) => buildMobileWebAppBundle({ outDir: join(scratch, 'd') })
      )
      expect(manifest.totalBytes).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)
      expect(manifest.assets.length).toBeLessThanOrEqual(
        mobileWebAppBundleMaxAssets(routeKeys.length, imageCount)
      )
      expect(chunkCount).toBeLessThanOrEqual(mobileWebAppBundleMaxChunks(routeKeys.length))
      expect(entryStaticBytes).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES)
    },
    120_000
  )

  it('says which node may be statically imported, and does not promise a route may', async () => {
    const source = await readFile(
      join(projectDir, 'config', 'scripts', 'verify-mobile-web-app-bundle.mjs'),
      'utf8'
    )
    // The bound reads like a per-route escape hatch and is not one: 5 of the 14 routes break it
    // on their own. What keeps it survivable is that expo-router wants a synchronous export off
    // layout nodes only, so the note has to name the layout and the export that drives it.
    const doc = source.slice(
      0,
      source.indexOf('export const MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES')
    )
    const note = doc.slice(doc.lastIndexOf('/**'))
    expect(note).toContain('h/_layout.tsx')
    expect(note).toContain('unstable_settings')
  })

  it('budgets what loads first well under what the whole page weighs', () => {
    // The point of the split: the entry budget is the one a route must not grow, and it is a
    // fraction of the total the bundle is still allowed to weigh.
    expect(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES).toBeLessThan(
      MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES
    )
  })

  it('derives the chunk ceiling from the route count, not from a measured number', async () => {
    // A chunk is emitted per distinct set of importers, so the count is combinatorial rather than
    // one per route. Measured while building this: 8 routes emit 23 chunks, 10 emit 40, 12 emit
    // 47, 14 emit 53 -- about 3 more per route at the top. The ceiling allows 4 and starts 16
    // above zero, so the next few routes land under it instead of failing on a pinned number.
    for (const [routes, measured] of [
      [8, 23],
      [10, 40],
      [12, 47],
      [14, 53]
    ]) {
      expect(mobileWebAppBundleMaxChunks(routes), `${String(routes)} routes`).toBeGreaterThan(
        measured
      )
    }
    expect(mobileWebAppBundleMaxChunks(14)).toBe(72)
    expect(mobileWebAppBundleMaxChunks(15) - mobileWebAppBundleMaxChunks(14)).toBe(4)
  })

  it('derives the asset ceiling so the chunk ceiling is always the one that trips first', () => {
    // A bundle's assets are its chunks, its images and the document. Asserting one constant under
    // another did not say that: with 42 images, 4 * 18 + 16 chunks plus 42 plus the document is
    // 131 assets, over the flat 128 the ceiling used to be, so from 18 routes on the asset count
    // failed first and named the wrong thing.
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
      const { manifest, routeKeys, imageCount } = await withScratch((scratch) =>
        buildMobileWebAppBundle({ outDir: join(scratch, 'e') })
      )
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
    // that ships a green build no device can open. At the 42 images the tree carries, 4r + 16 +
    // 42 + 1 crosses 256 at 50 routes, which Phase C reaches.
    expect(await readMobileWebBundleMaxAssets()).toBe(MOBILE_WEB_BUNDLE_MAX_ASSETS)
    expect(assertAssetCeilingFitsShell(49, 42, MOBILE_WEB_BUNDLE_MAX_ASSETS)).toBe(255)
    expect(() => assertAssetCeilingFitsShell(50, 42, MOBILE_WEB_BUNDLE_MAX_ASSETS)).toThrow(
      /259 .*256/
    )
  })
})

describe('the verifier', () => {
  itBundling(
    'accepts a bundle it has just built',
    async () => {
      await withScratch(async (scratch) => {
        const outDir = join(scratch, 'mobile-web-app')
        await buildMobileWebAppBundle({ outDir })
        await expect(verifyMobileWebAppBundle({ bundleDir: outDir })).resolves.toBeDefined()
      })
    },
    240_000
  )

  itBundling(
    "rejects a buildId the manifest's own asset list does not derive",
    async () => {
      await withScratch(async (scratch) => {
        const outDir = join(scratch, 'mobile-web-app')
        await buildMobileWebAppBundle({ outDir })
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
        const outDir = join(scratch, 'mobile-web-app')
        const { manifest } = await buildMobileWebAppBundle({ outDir })
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
