import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  sha256Hex,
  writeSyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'
import {
  MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MobileWebBundleGzipCatalogResultSchema
} from '../../../../../shared/mobile-web-bundle/locale-catalog-contract'

it('keeps the exact identity fence and refuses an extended content-addressed sidecar', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-catalog-delivery-'))
  try {
    installMobileWebBundleAppPath(scratch)
    const root = join(scratch, 'out', 'mobile-web')
    const dispatcher = mobileWebBundleDispatcher()
    const call = (method: string, knownSha256?: string) =>
      dispatcher.dispatch({
        id: 'fixture',
        authToken: 'tok',
        method,
        params: { locale: 'ru', ...(knownSha256 !== undefined && { knownSha256 }) }
      })
    const encoded = () => call(MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD)
    const atLimit = { text: `${'я'.repeat(196_551)}a` }
    writeSyntheticMobileWebBundle(root, 1, [], { ru: atLimit })
    const identity = await encoded()
    expect(identity.ok).toBe(true)
    if (!identity.ok) {
      throw new Error(identity.error.message)
    }
    expect(Buffer.byteLength(JSON.stringify(identity.result))).toBe(393_216)
    const larger = { text: `${atLimit.text}b` }
    const {
      catalogs: [catalog]
    } = writeSyntheticMobileWebBundle(root, 1, [], { ru: larger })
    expect(await encoded()).toMatchObject({
      ok: false,
      error: { message: 'mobile_web_bundle_asset_changed' }
    })
    expect(await call(MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD, catalog!.sha256)).toMatchObject({
      ok: true,
      result: { catalog: null }
    })
    expect(await call(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD)).toMatchObject({
      ok: true,
      result: { catalog: larger }
    })

    const raw = Buffer.from(JSON.stringify(larger))
    const gzip = gzipSync(raw, { level: 9 })
    gzip[9] = 255
    const sha256 = sha256Hex(gzip)
    const path = `catalogs/${sha256}.json.gz`
    writeFileSync(join(root, path), gzip)
    const manifestPath = join(root, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.catalogs[0].gzip = {
      path,
      sha256,
      byteLength: gzip.length,
      rawByteLength: raw.length,
      rawSha256: catalog!.sha256
    }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const reply = await encoded()
    expect(reply.ok).toBe(true)
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    const found = MobileWebBundleGzipCatalogResultSchema.parse(reply.result)
    expect(gunzipSync(Buffer.from(found.dataBase64, 'base64'))).toEqual(raw)
    appendFileSync(join(root, path), Buffer.of(1))
    expect(await encoded()).toMatchObject({
      ok: false,
      error: { message: 'mobile_web_bundle_asset_changed' }
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
