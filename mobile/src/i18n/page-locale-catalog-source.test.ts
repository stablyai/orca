import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import {
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD
} from '../../../src/shared/mobile-web-bundle/locale-catalog-contract'
import { decodeDeviceStoreValue } from '../device-store/device-store-value-codec'
import type { PageDeviceStore } from '../mobile-web-shell/bridge/page-storage/page-device-store'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

// The page build resolves mobile-i18n's catalog import to the .web module; mirror that here.
vi.mock('./locale-catalog-imports', () => import('./locale-catalog-imports.web'))
// A shell that skipped the catalog chunks: none is on disk, so every catalog comes from the host.
vi.mock('./bundled-locale-catalogs', () => ({
  importBundledLocaleCatalog: async () => {
    throw new Error('not on disk')
  }
}))

const { startPageLocaleCatalogs } = await import('./page-locale-catalog-source')
const i18n = await import('./mobile-i18n')

// Over one reply, as a complete Russian catalog is.
function largeCatalog(word: string): Record<string, string> {
  const catalog: Record<string, string> = {}
  for (let index = 0; index < 6000; index++) {
    catalog[`key${String(index)}`] = `${word} перевода номер ${String(index)} для телефона`
  }
  return catalog
}

type HostCatalog = { readonly locale: string; readonly bytes: Buffer; readonly sha256: string }

function hostCatalog(locale: string, catalog: Record<string, unknown>): HostCatalog {
  const bytes = Buffer.from(JSON.stringify(catalog), 'utf8')
  return { locale, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

type Answer = { result: unknown } | { error: { code: string; message: string } }
const requestSchema = z.looseObject({ locale: z.string(), offset: z.number().default(0) })

// A host that answers at once.
function fakeClient(serve: (method: string, params: z.output<typeof requestSchema>) => Answer) {
  const sent: { method: string; params: unknown }[] = []
  return {
    sent,
    getState: () => 'connected' as const,
    getGeneration: () => 1,
    onStateChange: () => () => {},
    sendRequest: async (method: string, params?: unknown): Promise<RpcResponse> => {
      sent.push({ method, params })
      const answer = serve(method, requestSchema.parse(params))
      return 'error' in answer
        ? { id: 'r', ok: false, error: answer.error }
        : { id: 'r', ok: true, result: answer.result }
    }
  }
}

// Windows on the contract grid: the first gzip, the rest identity, as a host may send either.
function rangeOf(catalog: HostCatalog, offset: number, sha256 = catalog.sha256): Answer {
  const end = Math.min(offset + MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES, catalog.bytes.length)
  const data = catalog.bytes.subarray(offset, end)
  const gzip = offset === 0
  return {
    result: {
      locale: catalog.locale,
      sha256,
      byteLength: catalog.bytes.length,
      offset,
      eof: end >= catalog.bytes.length,
      encoding: gzip ? 'gzip' : 'identity',
      dataBase64: (gzip ? gzipSync(data) : data).toString('base64')
    }
  }
}

// How a host that predates ranges refuses a phone's call to the method.
const OLD_HOST_REFUSAL: Answer = {
  error: {
    code: 'forbidden',
    message: `Method '${MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD}' is not available to mobile clients`
  }
}

function fakeStore(): PageDeviceStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    available: () => true,
    read: async (_table, keys) => ({
      status: 'ok',
      values: keys.map((key) => rows.get(key) ?? null)
    }),
    write: async (_table, ops) => {
      for (const op of ops) {
        if (op.value !== null) {
          rows.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  }
}

// Microtasks, then one macrotask, which is when the store write runs.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// Module state outlives a test, so each test uses its own locale.
describe('the page language catalog', () => {
  it('reads a catalog over one reply in ranges and keeps the whole it checked', async () => {
    const ru = hostCatalog('ru', largeCatalog('Строка'))
    const client = fakeClient((method, params) =>
      method === MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD
        ? rangeOf(ru, params.offset)
        : OLD_HOST_REFUSAL
    )
    const store = fakeStore()
    startPageLocaleCatalogs({ client, store })

    await i18n.activateMobileUiLocale('ru')
    await settle()

    expect(i18n.getMobileUiLocale()).toBe('ru')
    expect(i18n.translate('key5999', 'Hello')).toBe('Строка перевода номер 5999 для телефона')
    expect(client.sent).toEqual([
      {
        method: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
        params: { locale: 'ru', offset: 0 }
      },
      {
        method: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
        params: { locale: 'ru', offset: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES }
      }
    ])
    expect(decodeDeviceStoreValue(store.rows.get('i18n-catalog:ru') ?? '')).toMatchObject({
      sha256: ru.sha256
    })
  })

  it('opens in English when the reassembled bytes do not hash to the catalog the host named', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tr = hostCatalog('tr', largeCatalog('Satır'))
    const client = fakeClient((_method, params) => rangeOf(tr, params.offset, 'f'.repeat(64)))
    const store = fakeStore()
    startPageLocaleCatalogs({ client, store })

    await i18n.activateMobileUiLocale('tr')
    await settle()

    // Every window passed its own checks; only the whole is wrong.
    expect(client.sent.map(({ method }) => method)).toEqual([
      MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
      MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD
    ])
    expect(i18n.getMobileUiLocale()).toBe('en')
    expect(store.rows.size).toBe(0)
  })

  it('reads the catalog whole from a host that predates ranges', async () => {
    const client = fakeClient((method) =>
      method === MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD
        ? { result: { locale: 'de', sha256: 'a'.repeat(64), catalog: { greeting: 'Hallo' } } }
        : OLD_HOST_REFUSAL
    )
    startPageLocaleCatalogs({ client, store: fakeStore() })

    await i18n.activateMobileUiLocale('de')

    expect(i18n.translate('greeting', 'Hello')).toBe('Hallo')
    expect(client.sent.map(({ method }) => method)).toEqual([
      MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
      MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD
    ])
  })
})
