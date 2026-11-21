import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_REPLY_BYTES,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
  MobileWebBundleLocaleCatalogRangeResultSchema,
  MobileWebBundleLocaleCatalogResultSchema,
  type MobileWebBundleLocaleCatalogRangeResult
} from '../../../../../shared/mobile-web-bundle/locale-catalog-contract'
import type { RpcResponse } from '../../core'
import type { RpcDispatcher } from '../../dispatcher'
import { resetMobileWebBundleAssetVerdictsForTests } from './mobile-web-bundle-asset-reader'
import { resetMobileWebBundleReadAdmissionForTests } from './mobile-web-bundle-read-admission'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  sha256Hex,
  writeSyntheticMobileWebBundle,
  type SyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string
let dispatcher: RpcDispatcher
let bundle: SyntheticMobileWebBundle

// Cyrillic is two UTF-8 bytes a character, as in the complete Russian catalog that outgrew one reply.
const LARGE: Record<string, string> = (() => {
  const catalog: Record<string, string> = {}
  for (let index = 0; index < 5000; index++) {
    catalog[`key${String(index)}`] = `Строка перевода номер ${String(index)} для телефона`
  }
  return catalog
})()
const SMALL = { greeting: 'Hallo' }

function call(method: string, params: unknown): Promise<RpcResponse> {
  return dispatcher.dispatch({ id: 'req', authToken: 'tok', method, params })
}

function errorMessage(response: RpcResponse): string | undefined {
  return response.ok ? undefined : response.error.message
}

async function window(params: unknown): Promise<MobileWebBundleLocaleCatalogRangeResult> {
  const response = await call(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD, params)
  if (!response.ok) {
    throw new Error(`range failed: ${response.error.message}`)
  }
  return MobileWebBundleLocaleCatalogRangeResultSchema.parse(response.result)
}

function decoded(result: MobileWebBundleLocaleCatalogRangeResult): Buffer {
  const wire = Buffer.from(result.dataBase64 ?? '', 'base64')
  return result.encoding === 'gzip' ? gunzipSync(wire) : wire
}

function entryOf(locale: string) {
  return bundle.catalogs.find((catalog) => catalog.locale === locale)!
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-catalog-'))
  installMobileWebBundleAppPath(scratch)
  resetMobileWebBundleAssetVerdictsForTests()
  resetMobileWebBundleReadAdmissionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dispatcher = mobileWebBundleDispatcher()
  bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1, [], {
    de: SMALL,
    ru: LARGE
  })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('a language catalog larger than one reply', () => {
  it('arrives in windows that reassemble to the bytes its manifest entry hashes', async () => {
    const ru = entryOf('ru')
    expect(ru.byteLength).toBeGreaterThan(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_REPLY_BYTES)

    const first = await window({ locale: 'ru', offset: 0 })
    const second = await window({
      locale: 'ru',
      offset: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES
    })

    expect([first.eof, second.eof]).toEqual([false, true])
    expect([first.sha256, first.byteLength]).toEqual([ru.sha256, ru.byteLength])
    const whole = Buffer.concat([decoded(first), decoded(second)])
    expect(sha256Hex(whole)).toBe(ru.sha256)
    expect(JSON.parse(whole.toString('utf8'))).toEqual(LARGE)
  })

  // Pages that predate ranges read the single reply; a frame over the relay's would cut their connection.
  it('is never sent whole, while catalogs that fit one reply still are', async () => {
    const ru = entryOf('ru')

    const whole = await call(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD, { locale: 'ru' })
    const confirmed = await call(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD, {
      locale: 'ru',
      knownSha256: ru.sha256
    })
    const small = await call(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD, { locale: 'de' })

    expect(errorMessage(whole)).toBe('mobile_web_bundle_asset_unknown')
    // A stored copy a newer page read in ranges is still confirmed, without a body.
    expect(
      MobileWebBundleLocaleCatalogResultSchema.parse(confirmed.ok && confirmed.result)
    ).toEqual({
      locale: 'ru',
      sha256: ru.sha256,
      catalog: null
    })
    expect(
      MobileWebBundleLocaleCatalogResultSchema.parse(small.ok && small.result).catalog
    ).toEqual(SMALL)
  })

  it('answers a held copy without a window', async () => {
    const ru = entryOf('ru')

    const reply = await window({ locale: 'ru', offset: 0, knownSha256: ru.sha256 })

    expect(reply).toMatchObject({ sha256: ru.sha256, dataBase64: null })
  })

  it('answers asset-changed when the file no longer hashes to its manifest entry', async () => {
    const path = join(bundle.root, entryOf('ru').path)
    const tampered = readFileSync(path)
    tampered[10] ^= 1
    writeFileSync(path, tampered)

    const response = await call(MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD, {
      locale: 'ru',
      offset: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES
    })

    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
  })
})
