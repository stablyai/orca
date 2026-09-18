import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_APP_SHIMS,
  bundleMobileWebApp,
  buildMobileWebAppBundle
} from './build-mobile-web-app-bundle.mjs'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  ROUTE_CONTEXT_SOURCE,
  collectMobileWebAppRouteKeys,
  collectMobileWebAppRoutes,
  renderMobileWebAppRouteManifest
} from './mobile-web-app-route-manifest.mjs'
import {
  MOBILE_WEB_APP_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES,
  MOBILE_WEB_APP_SOURCE_DIRS
} from './verify-mobile-web-app-bundle.mjs'
import { assertNoCarriageReturnsInSource } from './verify-mobile-web-bundle.mjs'
import { MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES } from '../../src/shared/mobile-web-bundle/manifest-contract.js'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

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
    const keys = await collectMobileWebAppRouteKeys(appDir)
    expect(keys.some((key) => key.includes('.test.') || key.includes('+api.'))).toBe(false)
  })

  it('refuses an empty subtree rather than emitting a context with no routes', async () => {
    await expect(collectMobileWebAppRouteKeys(appDir, 'does-not-exist')).rejects.toThrow()
  })

  it('emits one static import per key', async () => {
    const source = renderMobileWebAppRouteManifest([
      { key: './h/index.tsx', module: '/app/h/index.tsx' },
      { key: './h/_layout.tsx', module: '/app/h/_layout.tsx' }
    ])
    expect(source).toContain('import * as route0 from "/app/h/index.tsx"')
    expect(source).toContain('import * as route1 from "/app/h/_layout.tsx"')
    // A lazy getter would need a chunk fetch, which the page's script-src 'self' does not serve.
    expect(source).not.toContain('import(')
  })

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

describe('the app bundle', () => {
  it('resolves react-native to react-native-web and leaves no require.context', async () => {
    const { script } = await bundleMobileWebApp()
    const source = script.toString('utf8')
    expect(source).not.toContain('require.context')
    // react-native-web's touch responder is proof the alias resolved rather than the native stub.
    expect(source).toContain('ResponderTouchHistoryStore')
  }, 120_000)

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
      expect(before.script.toString('utf8')).toContain('native-route-marker')

      await writeFile(join(directory, 'index.web.tsx'), route('web-route-marker'))
      const after = await bundleMobileWebApp({ appDir: scratch })
      expect(after.script.toString('utf8')).toContain('web-route-marker')
      expect(after.script.toString('utf8')).not.toContain('native-route-marker')
      // Different script bytes means a different asset sha and so a different buildId.
      expect(after.script.equals(before.script)).toBe(false)
    })
  }, 240_000)

  it('names every shim it applies', () => {
    expect(MOBILE_WEB_APP_SHIMS).toEqual([
      'react-native-web-alias',
      'js-as-jsx',
      'global-as-globalthis',
      'process-banner',
      'lucide-barrel-provider',
      'route-manifest'
    ])
  })

  it('keeps the shims out of the shipped Phase A bootstrap builder', async () => {
    const shipped = await readFile(
      join(projectDir, 'config', 'scripts', 'build-mobile-web-bundle.mjs'),
      'utf8'
    )
    expect(shipped).not.toContain('react-native-web')
    expect(shipped).not.toContain('lucide')
    expect(shipped).not.toContain('route-manifest')
  })

  it('embeds no absolute path from this checkout', async () => {
    const { script } = await bundleMobileWebApp()
    expect(script.toString('utf8')).not.toContain(projectDir)
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

  it('is not already exceeded by the current bundle', async () => {
    const { manifest } = await withScratch((scratch) =>
      buildMobileWebAppBundle({ outDir: join(scratch, 'd') })
    )
    expect(manifest.totalBytes).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)
    expect(manifest.assets.length).toBeLessThanOrEqual(MOBILE_WEB_APP_BUNDLE_MAX_ASSETS)
  }, 120_000)
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
