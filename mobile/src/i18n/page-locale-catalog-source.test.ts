import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'
import type { PageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'

// The page build resolves mobile-i18n's catalog import to the .web module; mirror that here.
vi.mock('./locale-catalog-imports', () => import('./locale-catalog-imports.web'))
// A shell that skipped the catalog chunks: only locales listed here are on disk.
const chunksOnDisk = new Map<string, Record<string, unknown>>()
vi.mock('./bundled-locale-catalogs', () => ({
  importBundledLocaleCatalog: async (locale: string) => {
    const catalog = chunksOnDisk.get(locale)
    if (!catalog) {
      throw new Error('not on disk')
    }
    return catalog
  }
}))

const OLD_SHA = 'a'.repeat(64)
const NEW_SHA = 'b'.repeat(64)

type SentRequest = {
  method: string
  params: unknown
  reply: (response: RpcResponse) => void
  fail: (error: Error) => void
}

function fakeClient(initial: ConnectionState) {
  let state = initial
  let generation = 1
  const listeners = new Set<(next: ConnectionState) => void>()
  const sent: SentRequest[] = []
  return {
    sent,
    getState: () => state,
    getGeneration: () => generation,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sendRequest: (method: string, params?: unknown) =>
      new Promise<RpcResponse>((reply, fail) => sent.push({ method, params, reply, fail })),
    moveTo(next: ConnectionState) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    // The shell swaps in an already-connected replacement, as on a relay-to-LAN move.
    cutover() {
      generation += 1
      for (const listener of listeners) {
        listener('connected')
      }
    }
  }
}

function fakeStore(rows: Record<string, string>): PageDeviceStore & { rows: Map<string, string> } {
  const stored = new Map(Object.entries(rows))
  return {
    rows: stored,
    available: () => true,
    read: async (_table, keys) => ({
      status: 'ok',
      values: keys.map((key) => stored.get(key) ?? null)
    }),
    write: async (_table, ops) => {
      for (const op of ops) {
        if (op.value !== null) {
          stored.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  }
}

const { startPageLocaleCatalogs } = await import('./page-locale-catalog-source')
const i18n = await import('./mobile-i18n')

// Module state outlives a test, so each test uses its own locale and publishes its own source.
function openPage(client: ReturnType<typeof fakeClient>, store: PageDeviceStore): void {
  startPageLocaleCatalogs({ client, store })
}

// Microtasks, then one macrotask, which is when the store write runs.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the page language catalog', () => {
  it('opens on the stored copy, then switches in place to the desktop newer one', async () => {
    const client = fakeClient('connected')
    const store = fakeStore({
      'i18n-catalog:de': encodeDeviceStoreValue({
        v: 1,
        sha256: OLD_SHA,
        catalog: { greeting: 'Hallo' }
      })
    })
    openPage(client, store)

    await i18n.activateMobileUiLocale('de')
    expect(i18n.translate('greeting', 'Hello')).toBe('Hallo')
    expect(client.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'mobileWeb.bundle.localeCatalog', params: { locale: 'de', knownSha256: OLD_SHA } }
    ])

    client.sent[0].reply({
      id: 'r1',
      ok: true,
      result: { locale: 'de', sha256: NEW_SHA, catalog: { greeting: 'Servus' } }
    })
    await settle()

    expect(i18n.getMobileUiLocale()).toBe('de')
    expect(i18n.translate('greeting', 'Hello')).toBe('Servus')
    expect(decodeDeviceStoreValue(store.rows.get('i18n-catalog:de') ?? '')).toEqual({
      v: 1,
      sha256: NEW_SHA,
      catalog: { greeting: 'Servus' }
    })
  })

  it('shows English offline with nothing stored, then the language once the desktop answers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = fakeClient('reconnecting')
    openPage(client, fakeStore({}))

    await i18n.activateMobileUiLocale('fr')
    expect(i18n.getMobileUiLocale()).toBe('en')
    expect(i18n.translate('greeting', 'Hello')).toBe('Hello')
    expect(client.sent).toHaveLength(0)

    client.moveTo('connected')
    await settle()
    expect(client.sent.map(({ params }) => params)).toEqual([{ locale: 'fr' }])
    client.sent[0].reply({
      id: 'r1',
      ok: true,
      result: { locale: 'fr', sha256: NEW_SHA, catalog: { greeting: 'Bonjour' } }
    })
    await settle()

    expect(i18n.getMobileUiLocale()).toBe('fr')
    expect(i18n.translate('greeting', 'Hello')).toBe('Bonjour')
  })

  it('opens in English when the first request fails on a live link, then switches on the next connection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = fakeClient('connected')
    openPage(client, fakeStore({}))

    const activation = i18n.activateMobileUiLocale('ja')
    await settle()
    client.sent[0].fail(new Error('timed out'))
    await activation
    expect(i18n.getMobileUiLocale()).toBe('en')

    client.moveTo('reconnecting')
    client.moveTo('connected')
    await settle()
    client.sent[1].reply({
      id: 'r2',
      ok: true,
      result: { locale: 'ja', sha256: NEW_SHA, catalog: { greeting: 'こんにちは' } }
    })
    await settle()

    expect(i18n.getMobileUiLocale()).toBe('ja')
    expect(i18n.translate('greeting', 'Hello')).toBe('こんにちは')
  })

  it('asks again on the connection a cutover swaps in, without waiting for another reconnect', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = fakeClient('reconnecting')
    openPage(client, fakeStore({}))

    await i18n.activateMobileUiLocale('ko')
    client.moveTo('connected')
    await settle()
    client.cutover()
    client.sent[0].fail(new Error('client cut over'))
    await settle()
    client.sent[1].reply({
      id: 'r2',
      ok: true,
      result: { locale: 'ko', sha256: NEW_SHA, catalog: { greeting: '안녕하세요' } }
    })
    await settle()

    expect(i18n.getMobileUiLocale()).toBe('ko')
    expect(i18n.translate('greeting', 'Hello')).toBe('안녕하세요')
  })
})
