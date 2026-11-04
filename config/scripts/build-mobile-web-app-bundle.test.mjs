import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  withScratch,
  readAppBundle,
  readWrittenBundle,
  copyWrittenBundle
} from './mobile-web-app/mobile-web-app-bundle-test-fixture.mjs'
import {
  bundleMobileWebApp,
  buildMobileWebAppBundle,
  entryStaticClosure,
  renameOutputsByContent,
  routeChunkNames
} from './build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app/mobile-web-app-route-manifest.mjs'
import {
  MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES,
  MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES,
  MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN,
  assertAssetCeilingFitsShell,
  mobileWebAppBundleMaxAssets,
  mobileWebAppBundleBudgetBytes,
  mobileWebAppBundleMaxChunks,
  readMobileWebBundleMaxAssets,
  verifyMobileWebAppBundle
} from './verify-mobile-web-app-bundle.mjs'
import { assertNoCarriageReturnsInSource } from './mobile-web-source-line-endings.mjs'
import {
  hashedAsset,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'
import { MOBILE_WEB_BUNDLE_MAX_ASSETS } from '../../src/shared/mobile-web-bundle/manifest-contract.js'
import { mobileWebAppDependenciesPresent } from './mobile-web-app/mobile-web-app-bundle-dependencies.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))

// Root shards lack mobile deps; real bundling tests run in mobile_web_app CI job.
const bundles = mobileWebAppDependenciesPresent()
const describeBundling = bundles ? describe : describe.skip
const itBundling = bundles ? it : it.skip

function allScriptSource({ script, chunks }) {
  return [script, ...chunks.map((chunk) => chunk.bytes)].map((bytes) => bytes.toString('utf8'))
}

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
        // Fail dropped route exports at build time; otherwise phones show blank screens without logs.
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
      expect(after.script.equals(before.script)).toBe(false)
    })
  }, 240_000)

  // Different-depth/symlink checkouts change esbuild input-key hashes and cascade through importers; content naming must preserve identical build IDs.
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

  itBundling(
    'is not already exceeded by the current bundle',
    async () => {
      const {
        manifest,
        chunkCount,
        catalogChunkCount,
        catalogBytes,
        entryStaticBytes,
        imageCount,
        routeKeys
      } = await readWrittenBundle()
      expect(mobileWebAppBundleBudgetBytes(manifest) - catalogBytes).toBeLessThanOrEqual(
        MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES
      )
      expect(manifest.assets.length).toBeLessThanOrEqual(
        mobileWebAppBundleMaxAssets(routeKeys.length, imageCount, catalogChunkCount)
      )
      expect(chunkCount).toBeLessThanOrEqual(mobileWebAppBundleMaxChunks(routeKeys.length))
      // Excess unused envelope margin means stale measurement; remeasure instead of adding headroom.
      expect(
        mobileWebAppBundleMaxChunks(routeKeys.length) - chunkCount,
        'the chunk envelope is looser than this build; re-measure MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP'
      ).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN)
      expect(entryStaticBytes).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES)
    },
    120_000
  )

  itBundling(
    'keeps the derived ceiling under the map the phone actually holds',
    async () => {
      const { manifest, routeKeys, imageCount, catalogChunkCount } = await readWrittenBundle()
      const ceiling = mobileWebAppBundleMaxAssets(routeKeys.length, imageCount, catalogChunkCount)
      expect(manifest.assets.length).toBeLessThanOrEqual(ceiling)
      // The native side refuses a manifest past this, so the derived ceiling has to stay inside it.
      expect(ceiling).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_MAX_ASSETS)
      const shellCeiling = await readMobileWebBundleMaxAssets()
      expect(
        assertAssetCeilingFitsShell(routeKeys.length, imageCount, shellCeiling, catalogChunkCount)
      ).toBe(ceiling)
    },
    120_000
  )
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
        // Consistent digests/buildId cannot reveal stale sources; verifier’s two fresh builds must detect them.
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
  it('fails on a CRLF source file', async () => {
    await withScratch(async (scratch) => {
      await writeFile(join(scratch, 'route.tsx'), 'export default null\r\n', 'utf8')
      await expect(assertNoCarriageReturnsInSource(scratch)).rejects.toThrow('CRLF')
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
    // Cycles have no final dependency names/content hash; fail if esbuild ever stops emitting a DAG.
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
      // Only metafile maps routes to chunks; missing output must fail before phones request undefined/404.
      expect(() =>
        routeChunkNames({ outputs: {} }, [{ key: './index.tsx', module }], new Map())
      ).toThrow(/\.\/index\.tsx reached no output/)
    })
  })
})
