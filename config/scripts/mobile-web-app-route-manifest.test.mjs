import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  ROUTE_CONTEXT_SOURCE,
  ROUTE_MODULE_SYNCHRONOUS_EXPORTS,
  collectMobileWebAppRouteKeys,
  collectMobileWebAppRoutes,
  renderMobileWebAppRouteManifest,
  routeModuleSynchronousExports
} from './mobile-web-app-route-manifest.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

// The sharded `test` job does not install mobile dependencies, so anything that runs esbuild over
// the route tree is skipped there and run for real in pr.yml's mobile_web_app job.
const itBundling = mobileWebAppDependenciesPresent() ? it : it.skip

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-routes-test-'))
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

  itBundling(
    'reads a .js route that carries JSX, which the app tree allows',
    async () => {
      await withScratch(async (scratch) => {
        // React Native ships untranspiled JSX inside .js, and collectMobileWebAppRoutes accepts a
        // .js route, so the guard has to parse one the same way the bundle does.
        const file = join(scratch, 'jsx-route.js')
        await writeFile(
          file,
          'const boundary = () => <div />\nexport { boundary as ErrorBoundary }\nexport default () => <div />\n',
          'utf8'
        )
        expect((await routeModuleSynchronousExports(file)).named).toEqual(['ErrorBoundary'])
      })
    },
    60_000
  )

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

describe('the web entry', () => {
  it('leaves the suspense boundary to expo-router', async () => {
    const entry = await readFile(join(projectDir, 'mobile', 'web-entry', 'index.tsx'), 'utf8')
    // A second boundary around the whole tree catches nothing the router has not already caught,
    // and would only make the fallback ambiguous about which layer suspended.
    expect(entry).not.toContain('Suspense')
  })

  itBundling('because the router already wraps every screen in one', async () => {
    // The premise of the test above, read off the copy that is bundled: getQualifiedRouteComponent
    // wraps each screen itself, which is what makes the lazy route manifest safe without a
    // boundary of our own.
    const useScreens = await readFile(
      join(projectDir, 'mobile', 'node_modules', 'expo-router', 'build', 'useScreens.js'),
      'utf8'
    )
    expect(useScreens).toContain('<react_1.default.Suspense fallback=')
  })
})
