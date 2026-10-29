// Bare-Node packaging cannot import prebuild TS contract, leaving three serializers that must remain byte-identical.
// Drift rejects valid bundle or makes phone recompute different ID and download indefinitely.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  computeMobileWebBundleBuildId,
  serializeMobileWebBundleAssets as serializeInBuilder
} from './mobile-web-bundle-manifest.mjs'
import {
  computeMobileWebBundleId,
  MobileWebBundleManifestSchema,
  serializeMobileWebBundleAssets as serializeInContract
} from '../../src/shared/mobile-web-bundle/manifest-contract'

const require = createRequire(import.meta.url)
const { serializeAssets: serializeInGuard } = require('./verify-packaged-mobile-web-bundle.cjs')

const digest = (hex) => `${hex}`.padStart(64, '0')

// Mixed types/nested paths and uppercase ordering expose localeCompare drift from canonical code-unit sort.
const ASSETS = [
  {
    path: 'assets/Za.js',
    sha256: digest('a1'),
    byteLength: 2048,
    contentType: 'text/javascript; charset=utf-8'
  },
  { path: 'assets/aQ.css', sha256: digest('b2'), byteLength: 512, contentType: 'text/css' },
  {
    path: 'assets/nested/mark.png',
    sha256: digest('c3'),
    byteLength: 40_960,
    contentType: 'image/png'
  },
  {
    path: 'index.html',
    sha256: digest('d4'),
    byteLength: 640,
    contentType: 'text/html; charset=utf-8'
  }
]

const REORDERED = [ASSETS[3], ASSETS[1], ASSETS[0], ASSETS[2]]
const REVERSED = ASSETS.toReversed()

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

describe('the three mobile web bundle serializers', () => {
  it('produce one string for the builder, the packaging guard, and the shared contract', () => {
    const fromContract = serializeInContract(ASSETS)

    expect(serializeInBuilder(ASSETS)).toBe(fromContract)
    expect(serializeInGuard(ASSETS)).toBe(fromContract)
  })

  it.each([
    ['reordered', REORDERED],
    ['reversed', REVERSED]
  ])('are order-independent, so %s input serializes identically', (_label, input) => {
    const expected = serializeInContract(ASSETS)

    expect(serializeInContract(input)).toBe(expected)
    expect(serializeInBuilder(input)).toBe(expected)
    expect(serializeInGuard(input)).toBe(expected)
  })

  it('leaves the caller-supplied array untouched, so a build cannot depend on the sort', () => {
    const input = [...REORDERED]
    serializeInContract(input)
    serializeInBuilder(input)
    serializeInGuard(input)

    expect(input).toEqual(REORDERED)
  })

  it('emit exactly path, sha256, byteLength, contentType, in that order, and nothing else', () => {
    const decorated = ASSETS.map((asset) => ({ ...asset, sourcePath: '/tmp/ignored', extra: 1 }))

    const expected =
      '[{"path":"assets/Za.js","sha256":"00000000000000000000000000000000000000000000000000000000000000a1","byteLength":2048,"contentType":"text/javascript; charset=utf-8"},' +
      '{"path":"assets/aQ.css","sha256":"00000000000000000000000000000000000000000000000000000000000000b2","byteLength":512,"contentType":"text/css"},' +
      '{"path":"assets/nested/mark.png","sha256":"00000000000000000000000000000000000000000000000000000000000000c3","byteLength":40960,"contentType":"image/png"},' +
      '{"path":"index.html","sha256":"00000000000000000000000000000000000000000000000000000000000000d4","byteLength":640,"contentType":"text/html; charset=utf-8"}]'
    for (const serialize of [serializeInContract, serializeInBuilder, serializeInGuard]) {
      expect(serialize(decorated)).toBe(expected)
    }
  })

  it('hash to one buildId, which the manifest schema then accepts', () => {
    const buildId = computeMobileWebBundleId(REORDERED)

    expect(computeMobileWebBundleBuildId(REORDERED)).toBe(buildId)
    expect(sha256Hex(serializeInGuard(REORDERED))).toBe(buildId)

    const manifest = {
      schemaVersion: 1,
      buildId,
      desktopVersion: '1.4.200',
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes: ASSETS.reduce((total, asset) => total + asset.byteLength, 0),
      assets: [...ASSETS],
      routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
    }

    expect(MobileWebBundleManifestSchema.parse(manifest).buildId).toBe(buildId)
  })
})
