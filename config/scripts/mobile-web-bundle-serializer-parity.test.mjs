/**
 * The canonical serialization that buildId hashes exists three times, because the two packaging
 * scripts run on bare node before any build output exists and so cannot import the TypeScript
 * contract. Three copies drift; this is what stops them. A divergence in any one of them would
 * reject every honest bundle at packaging, or ship a bundle whose id the phone recomputes
 * differently and re-downloads forever.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  computeMobileWebBundleBuildId,
  serializeMobileWebBundleAssets as serializeInBuilder
} from './build-mobile-web-bundle.mjs'
import {
  computeMobileWebBundleId,
  MobileWebBundleManifestSchema,
  serializeMobileWebBundleAssets as serializeInContract
} from '../../src/shared/mobile-web-bundle/manifest-contract'

const require = createRequire(import.meta.url)
const { serializeAssets: serializeInGuard } = require('./verify-packaged-mobile-web-bundle.cjs')

const digest = (hex) => `${hex}`.padStart(64, '0')

/**
 * Mixed content types, a nested path, and an uppercase segment that sorts before a lowercase one
 * only under code-unit order: `localeCompare` would put `assets/aQ.js` first, so any serializer
 * that reached for it produces a different string here.
 */
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

    expect(serializeInContract(decorated)).toBe(serializeInContract(ASSETS))
    expect(serializeInBuilder(decorated)).toBe(serializeInContract(ASSETS))
    expect(serializeInGuard(decorated)).toBe(serializeInContract(ASSETS))
    expect(JSON.parse(serializeInContract(ASSETS))[0]).toEqual({
      path: 'assets/Za.js',
      sha256: digest('a1'),
      byteLength: 2048,
      contentType: 'text/javascript; charset=utf-8'
    })
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
      // Outside the hash on purpose, which the assertion below is what says.
      routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
    }

    expect(MobileWebBundleManifestSchema.parse(manifest).buildId).toBe(buildId)
  })
})
