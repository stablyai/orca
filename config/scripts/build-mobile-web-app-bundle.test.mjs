import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_APP_SHIMS,
  bundleMobileWebApp,
  buildMobileWebAppBundle,
  entryStaticClosure,
  mobileWebAppBuildOptions
} from './build-mobile-web-app-bundle.mjs'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  ROUTE_CONTEXT_SOURCE,
  ROUTE_MODULE_SYNCHRONOUS_EXPORTS,
  collectMobileWebAppRouteKeys,
  collectMobileWebAppRoutes,
  renderMobileWebAppRouteManifest,
  routeModuleSynchronousExports
} from './mobile-web-app-route-manifest.mjs'
import {
  MOBILE_WEB_APP_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_APP_BUNDLE_MAX_CHUNKS,
  MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES,
  MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES,
  MOBILE_WEB_APP_SOURCE_DIRS,
  verifyMobileWebAppBundle
} from './verify-mobile-web-app-bundle.mjs'
import {
  BINARY_SOURCE_EXTENSIONS,
  assertNoCarriageReturnsInSource
} from './verify-mobile-web-bundle.mjs'
import {
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './build-mobile-web-bundle.mjs'
import { MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES } from '../../src/shared/mobile-web-bundle/manifest-contract.js'
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

describe('route manifest', () => {
  it('collects the h/ subtree and nothing above it', async () => {
    const keys = await collectMobileWebAppRouteKeys(appDir)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.startsWith(`./${MOBILE_WEB_APP_ROUTE_ROOT}/`)).toBe(true)
    }
    // The native-only shell (pairing, settings, notifications) must not reach the page bundle.
    expect(keys).not.toContain('./_layout.tsx')
    expect(keys).not.toContain('./pair.tsx')
  })

  it('is sorted, so the generated module is a pure function of the tree', async () => {
    const keys = await collectMobileWebAppRouteKeys(appDir)
    expect(keys).toEqual([...keys].sort())
  })

  it('excludes test files and API routes', async () => {
    // mobile/app holds none of these today, so assert the rule against a tree that does.
    await withScratch(async (scratch) => {
      const directory = join(scratch, MOBILE_WEB_APP_ROUTE_ROOT)
      await mkdir(directory, { recursive: true })
      for (const name of [
        'index.tsx',
        'index.test.tsx',
        'index.spec.tsx',
        'shape.d.ts',
        '+api.ts',
        'tokens+api.ts',
        '+middleware.ts',
        'notes.md'
      ]) {
        await writeFile(join(directory, name), 'export default null\n', 'utf8')
      }
      expect(await collectMobileWebAppRouteKeys(scratch)).toEqual(['./h/index.tsx'])
    })
    expect(await collectMobileWebAppRouteKeys(appDir)).not.toContain('./h/_layout.test.tsx')
  })

  it('refuses an empty subtree rather than emitting a context with no routes', async () => {
    await expect(collectMobileWebAppRouteKeys(appDir, 'does-not-exist')).rejects.toThrow()
  })

  it('emits one lazy import per key, and no static import of a route', () => {
    const source = renderMobileWebAppRouteManifest([
      { key: './h/index.tsx', module: '/app/h/index.tsx' },
      { key: './h/_layout.tsx', module: '/app/h/_layout.tsx' }
    ])
    expect(source).toContain('["./h/index.tsx"]: { default: lazy(() => import("/app/h/index.tsx"))')
    expect(source).toContain(
      '["./h/_layout.tsx"]: { default: lazy(() => import("/app/h/_layout.tsx"))'
    )
    // A static import is what collapses the split back into one chunk.
    expect(source).not.toContain('import * as route')
    expect(source.match(/import\(/g)).toHaveLength(2)
  })

  it('leaves the RequireContext itself synchronous', () => {
    // expo-router calls keys() to build the route tree before anything renders, so the context
    // may not be a promise; only the screen behind each key is deferred.
    const source = renderMobileWebAppRouteManifest([
      { key: './h/index.tsx', module: '/app/h/index.tsx' }
    ])
    expect(source).toContain('routeContext.keys = () => keys.slice()')
    expect(source).not.toContain('async function routeContext')
    expect(source).not.toContain('await import(')
  })

  it('has no route carrying an export a lazy module would swallow', async () => {
    const routes = await collectMobileWebAppRoutes(appDir)
    expect(routes.length).toBeGreaterThan(0)
    for (const { module } of routes) {
      const { named, starExports } = await routeModuleSynchronousExports(module)
      // expo-router reads these off the namespace while it builds the tree, which a module behind
      // import() cannot answer. Adding one to a page route needs a static import for that route.
      expect(named, `${module} exports ${named.join(', ')}`).toEqual([])
      expect(starExports, `${module} re-exports all of ${starExports.join(', ')}`).toEqual([])
    }
  })

  // Each of these puts the name on the namespace without declaring it, which is why the guard
  // reads esbuild's parse instead of the source text.
  it('reads the names off the namespace, not off a declaration', async () => {
    expect(ROUTE_MODULE_SYNCHRONOUS_EXPORTS).toEqual(['unstable_settings', 'ErrorBoundary'])
    await withScratch(async (scratch) => {
      const exportsOf = async (name, source) => {
        const file = join(scratch, name)
        await writeFile(file, source, 'utf8')
        return routeModuleSynchronousExports(file)
      }
      expect(
        (await exportsOf('declared.tsx', 'export const unstable_settings = { anchor: "x" }\n'))
          .named
      ).toEqual(['unstable_settings'])
      expect(
        (
          await exportsOf(
            'aliased.tsx',
            'const settings = { anchor: "x" }\nexport { settings as unstable_settings }\n'
          )
        ).named
      ).toEqual(['unstable_settings'])
      expect((await exportsOf('classy.tsx', 'export class ErrorBoundary {}\n')).named).toEqual([
        'ErrorBoundary'
      ])
      expect(
        (await exportsOf('forwarded.tsx', 'export { ErrorBoundary } from "./boundary"\n')).named
      ).toEqual(['ErrorBoundary'])
      expect(
        (await exportsOf('plain.tsx', 'export default function Route() { return null }\n')).named
      ).toEqual([])
    })
  }, 60_000)

  it('refuses a star re-export rather than reading it as clean', async () => {
    await withScratch(async (scratch) => {
      const file = join(scratch, 'star.tsx')
      // Nothing here says whether ./boundary exports ErrorBoundary, and answering would mean
      // bundling the route. Reported as a violation so the guard fails closed.
      await writeFile(file, 'export * from "./boundary"\nexport default null\n', 'utf8')
      const { named, starExports } = await routeModuleSynchronousExports(file)
      expect(named).toEqual([])
      expect(starExports).toEqual(['./boundary'])
    })
  }, 60_000)

  it('imports a .web.tsx sibling under the native route key', async () => {
    await withScratch(async (scratch) => {
      const directory = join(scratch, MOBILE_WEB_APP_ROUTE_ROOT)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'index.tsx'), 'export default function Route() {}\n')
      expect(await collectMobileWebAppRoutes(scratch)).toEqual([
        { key: './h/index.tsx', module: join(directory, 'index.tsx') }
      ])
      await writeFile(join(directory, 'index.web.tsx'), 'export default function Route() {}\n')
      // The key is still the native filename, so the override changes the code and not the URL.
      expect(await collectMobileWebAppRoutes(scratch)).toEqual([
        { key: './h/index.tsx', module: join(directory, 'index.web.tsx') }
      ])
    })
  })
})

describe('the synthesized RequireContext', () => {
  const build = (modules) =>
    new Function('modules', `${ROUTE_CONTEXT_SOURCE}; return routeContext`)(modules)

  it('answers the four members expo-router reads', () => {
    const context = build({ './h/index.tsx': { default: 'screen' } })
    expect(context.keys()).toEqual(['./h/index.tsx'])
    expect(context('./h/index.tsx')).toEqual({ default: 'screen' })
    expect(context.resolve('./h/index.tsx')).toBe('./h/index.tsx')
    expect(context.id).toBe('orca-mobile-web-app-routes')
  })

  it('hands out a copy of keys, so a caller cannot mutate the route tree', () => {
    const context = build({ './h/index.tsx': {} })
    context.keys().push('./injected.tsx')
    expect(context.keys()).toEqual(['./h/index.tsx'])
  })

  it('throws rather than returning undefined for an unknown key', () => {
    const context = build({ './h/index.tsx': {} })
    expect(() => context('./missing.tsx')).toThrow('no route module')
    expect(() => context.resolve('./missing.tsx')).toThrow('cannot resolve route')
  })

  it('does not answer inherited Object keys', () => {
    const context = build({ './h/index.tsx': {} })
    expect(() => context('constructor')).toThrow('no route module')
  })
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

  it('asks esbuild for the split the budgets assume', async () => {
    const options = mobileWebAppBuildOptions(await collectMobileWebAppRoutes(appDir))
    // Each of these is load-bearing for a budget below: esm and splitting are what make a route a
    // chunk, and the metafile is the only thing that says which imports are static.
    expect(options.format).toBe('esm')
    expect(options.splitting).toBe(true)
    expect(options.chunkNames).toBe('[hash]')
    expect(options.metafile).toBe(true)
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
    expect(MOBILE_WEB_APP_BUNDLE_MAX_ASSETS).toBeGreaterThan(1)
  })

  itBundling(
    'is not already exceeded by the current bundle',
    async () => {
      const { manifest, chunkCount, entryStaticBytes } = await withScratch((scratch) =>
        buildMobileWebAppBundle({ outDir: join(scratch, 'd') })
      )
      expect(manifest.totalBytes).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)
      expect(manifest.assets.length).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_ASSETS)
      expect(chunkCount).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_CHUNKS)
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
    // Every chunk is a manifest asset, so the chunk ceiling has to leave room for the images.
    expect(MOBILE_WEB_APP_BUNDLE_MAX_CHUNKS).toBeLessThan(MOBILE_WEB_APP_BUNDLE_MAX_ASSETS)
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
