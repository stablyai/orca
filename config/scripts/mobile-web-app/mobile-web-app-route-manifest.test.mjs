import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  ROUTE_MODULE_SYNCHRONOUS_EXPORTS,
  collectMobileWebAppRouteKeys,
  collectMobileWebAppRoutes,
  routeModuleSynchronousExports
} from './mobile-web-app-route-manifest.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const projectDir = fileURLToPath(new URL('../../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

// Root shards omit mobile dependencies; route-tree builds run in mobile_web_app job.
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
  it('carries no root layout for a tree without a web sibling of it', async () => {
    await withScratch(async (scratch) => {
      await mkdir(join(scratch, MOBILE_WEB_APP_ROUTE_ROOT), { recursive: true })
      await writeFile(join(scratch, '_layout.tsx'), 'export default null\n', 'utf8')
      await writeFile(join(scratch, MOBILE_WEB_APP_ROUTE_ROOT, 'index.tsx'), 'export default 1\n')
      expect(await collectMobileWebAppRouteKeys(scratch)).toEqual(['./h/index.tsx'])
    })
  })

  it('excludes test files and API routes', async () => {
    // Synthetic tree exercises absent-today forbidden route exports.
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

  // Alias/reexport controls require namespace parse, not declaration-name matching.
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
      // Unresolved export * cannot prove namespace clean without bundling; fail closed.
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
        // Guard must accept JSX-in-.js routes like actual RN bundler.
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
      // Preserve native key so web override changes implementation without changing URL.
      expect(await collectMobileWebAppRoutes(scratch)).toEqual([
        { key: './h/index.tsx', module: join(directory, 'index.web.tsx') }
      ])
    })
  })
})
