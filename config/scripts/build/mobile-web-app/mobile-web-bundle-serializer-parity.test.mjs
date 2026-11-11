import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { serializeMobileWebBundleAssets as serializeInBuilder } from './mobile-web-bundle-manifest.mjs'
import { serializeMobileWebBundleAssets as serializeInContract } from '../../../../src/shared/mobile-web-bundle/manifest-contract'

const require = createRequire(import.meta.url)
const {
  serializeAssets: serializeInGuard
} = require('../../desktop-distribution/runtime-verification/verify-packaged-mobile-web-bundle.cjs')

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

describe('the three mobile web bundle serializers', () => {
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
})
