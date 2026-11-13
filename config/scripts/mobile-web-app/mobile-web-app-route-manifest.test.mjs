import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_APP_ROUTE_ROOT,
  collectMobileWebAppRoutes
} from './mobile-web-app-route-manifest.mjs'

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-routes-test-'))
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

describe('route manifest', () => {
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
