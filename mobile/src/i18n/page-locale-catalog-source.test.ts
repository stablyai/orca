import { expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  DEVICE_STORE_MAX_VALUE_LENGTH,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { createHostLocaleCatalogLoader } from './page-locale-catalog-source'
import { requestHostLocaleCatalog } from './page-locale-catalog-rpc'

const sha256 = '0'.repeat(64)
const row = { v: 1, sha256, catalog: { notice: 'Русский' } }
const valid = encodeDeviceStoreValue(row)
const decodedLimit = 786_526
const atDecodedLimit = {
  ...row,
  catalog: {
    notice: 'a'.repeat(decodedLimit - JSON.stringify({ ...row, catalog: { notice: '' } }).length)
  }
}
const refused = {
  id: 'fixture',
  ok: false,
  error: { code: 'invalid_argument', message: 'fixture host has no catalog' },
  _meta: { runtimeId: 'fixture' }
} satisfies RpcResponse

function coldHost(value: string) {
  const requested: unknown[] = []
  const stop = new AbortController()
  const response = Promise.withResolvers<RpcResponse>()
  const sent = Promise.withResolvers<void>()
  const load = createHostLocaleCatalogLoader(
    {
      client: {
        getState: () => 'connected',
        getGeneration: () => 1,
        onStateChange: () => () => {},
        sendRequest: (_method, params) => {
          requested.push(params)
          sent.resolve()
          return response.promise
        }
      },
      store: {
        available: () => true,
        read: async () => ({ status: 'ok', values: [value] }),
        write: async () => ({ written: true })
      }
    },
    stop.signal,
    () => true
  )
  return { load, requested, stop, response, sent: sent.promise }
}

function breakTrailer(offset: number): string {
  const bytes = Buffer.from(valid, 'base64')
  const index = bytes.length - offset
  bytes[index] = bytes[index]! ^ 1
  return bytes.toString('base64')
}

it('admits one complete member to first paint and known SHA at the cache limits', async () => {
  const historical = Buffer.from(valid, 'base64')
  const header = Buffer.from(historical.subarray(0, 10))
  header[3] = 16 // Pad the gzip comment up to the exact encoded limit.
  const comment = Buffer.alloc((DEVICE_STORE_MAX_VALUE_LENGTH * 3) / 4 - historical.length, 97)
  comment[comment.length - 1] = 0
  const atEncodedLimit = Buffer.concat([header, comment, historical.subarray(10)]).toString(
    'base64'
  )
  expect(atEncodedLimit).toHaveLength(524_288)
  for (const [value, notice] of [
    [valid, row.catalog.notice],
    [atEncodedLimit, row.catalog.notice],
    [encodeDeviceStoreValue(atDecodedLimit), atDecodedLimit.catalog.notice]
  ] as const) {
    const host = coldHost(value)
    try {
      const initial = host.load('ru')
      expect(host.load('ru')).toBe(initial)
      expect((await initial).catalog.notice).toBe(notice)
      await host.sent
      expect(host.requested).toEqual([{ locale: 'ru', knownSha256: sha256 }])
    } finally {
      host.stop.abort()
      host.response.resolve(refused)
    }
  }
})

it('keeps malformed and oversized v1 rows out of both admission paths', async () => {
  const trailing = Buffer.concat([Buffer.from(valid, 'base64'), Buffer.of(0)])
  // A second member that changes the bytes fails the trailer; a byte-identical repeat decodes the same verified row.
  const other = Buffer.from(encodeDeviceStoreValue({ ...row, catalog: { notice: 'x' } }), 'base64')
  const concatenated = Buffer.concat([Buffer.from(valid, 'base64'), other])
  const prepended = Buffer.concat([other, Buffer.from(valid, 'base64')])
  const oversized = encodeDeviceStoreValue({
    ...row,
    catalog: { notice: `${atDecodedLimit.catalog.notice}a` }
  })
  const oversizedWithSmallHint = Buffer.from(oversized, 'base64')
  oversizedWithSmallHint.writeUInt32LE(16, oversizedWithSmallHint.length - 4)
  for (const invalid of [
    breakTrailer(8),
    breakTrailer(4),
    Buffer.from(valid, 'base64').subarray(0, -3).toString('base64'),
    trailing.toString('base64'),
    concatenated.toString('base64'),
    prepended.toString('base64'),
    gzipSync(Buffer.of(0xc3, 0x28)).toString('base64'),
    encodeDeviceStoreValue({ ...row, catalog: [] }),
    encodeDeviceStoreValue({ ...row, sha256: 'invalid' }),
    `${valid}\n`,
    'a'.repeat(DEVICE_STORE_MAX_VALUE_LENGTH + 4),
    oversized,
    oversizedWithSmallHint.toString('base64')
  ]) {
    const host = coldHost(invalid)
    try {
      host.response.resolve(refused)
      await expect(host.load('ru')).rejects.toThrow('first paint')
      expect(host.requested).toEqual([{ locale: 'ru' }])
    } finally {
      host.stop.abort()
    }
  }
})

it('restricts the raw retry to the encoded catalog method being absent', async () => {
  const exact = "Method 'mobileWeb.bundle.localeCatalogEncoded' is not available to mobile clients"
  for (const { code, message, retry } of [
    { code: 'method_not_found', message: 'unsupported', retry: true },
    { code: 'forbidden', message: exact, retry: true },
    { code: 'forbidden', message: `denied: ${exact}`, retry: false },
    {
      code: 'forbidden',
      message: "Method 'worktree.rm' is not available to mobile clients",
      retry: false
    }
  ]) {
    const calls: string[] = []
    const catalog = requestHostLocaleCatalog(
      {
        getState: () => 'connected',
        onStateChange: () => () => {},
        sendRequest: async (method) => {
          calls.push(method)
          return calls.length === 1
            ? { ...refused, error: { code, message } }
            : { id: 'fixture', ok: true, _meta: refused._meta, result: { locale: 'ru', ...row } }
        }
      },
      'ru',
      null,
      new AbortController().signal,
      () => true
    )
    await (retry
      ? expect(catalog).resolves.toEqual({ sha256, catalog: row.catalog })
      : expect(catalog).rejects.toThrow('answered no ru catalog'))
    expect(calls).toEqual(
      retry
        ? ['mobileWeb.bundle.localeCatalogEncoded', 'mobileWeb.bundle.localeCatalog']
        : ['mobileWeb.bundle.localeCatalogEncoded']
    )
  }
})

it('shares the original deadline with an exact old-host denial retry', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000)
  const denied = {
    ...refused,
    error: {
      code: 'forbidden',
      message: "Method 'mobileWeb.bundle.localeCatalogEncoded' is not available to mobile clients"
    }
  }
  try {
    for (const [elapsed, remaining] of [
      [10_250.5, 19_749],
      [30_000, 0],
      [30_001, 0]
    ] as const) {
      clock.mockReturnValue(1_000)
      const calls: [string, number | undefined][] = []
      const outcome = requestHostLocaleCatalog(
        {
          getState: () => 'connected',
          onStateChange: () => () => {},
          sendRequest: async (method, _params, options) => {
            calls.push([method, options?.timeoutMs])
            if (calls.length === 1) {
              clock.mockReturnValue(1_000 + elapsed)
              return denied
            }
            return {
              id: 'fixture',
              ok: true,
              _meta: refused._meta,
              result: { locale: 'ru', ...row }
            }
          }
        },
        'ru',
        null,
        new AbortController().signal,
        () => true
      )
      const initial: [string, number] = ['mobileWeb.bundle.localeCatalogEncoded', 30_000]
      if (remaining) {
        await expect(outcome).resolves.toEqual({ sha256, catalog: row.catalog })
        expect(calls).toEqual([initial, ['mobileWeb.bundle.localeCatalog', remaining]])
      } else {
        await expect(outcome).rejects.toThrow('answered no ru catalog')
        expect(calls).toEqual([initial])
      }
    }
  } finally {
    clock.mockRestore()
  }
})
