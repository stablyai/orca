import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { MobileWebBundleRouteSchema } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  contentTypeForExtension,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'

const outDirs = []
afterEach(async () => {
  await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeTree(routes) {
  const outDir = await mkdtemp(join(tmpdir(), 'orca-mobile-web-manifest-'))
  outDirs.push(outDir)
  const bytes = Buffer.from('<!doctype html>\n', 'utf8')
  return writeMobileWebBundleTree({
    outDir,
    written: [
      {
        path: MOBILE_WEB_BUNDLE_ENTRYPOINT,
        bytes,
        sha256: sha256Hex(bytes),
        byteLength: bytes.byteLength,
        contentType: contentTypeForExtension('html')
      }
    ],
    desktopVersion: await readDesktopVersion(),
    protocolWindow: await readProtocolWindow(),
    routes
  })
}

// A route the contract rejects makes the desktop refuse the whole manifest, so every phone page fails to load.
test('every declared page route, grants included, passes the manifest contract', () => {
  for (const route of MOBILE_WEB_PAGE_ROUTES) {
    const parsed = MobileWebBundleRouteSchema.safeParse(route)
    expect(parsed.error?.issues, route.pathname).toBeUndefined()
  }
})

test('the build refuses to write a manifest the desktop would reject', async () => {
  const routes = MOBILE_WEB_PAGE_ROUTES.map(({ pathname, grants }) => ({ pathname, grants }))
  await expect(writeTree(routes)).resolves.toMatchObject({ manifest: { routes } })
  await expect(
    writeTree([{ pathname: '/h/[hostId]', grants: ['native.sharedAgents.act'] }])
  ).rejects.toThrow('does not match the manifest contract')
})
