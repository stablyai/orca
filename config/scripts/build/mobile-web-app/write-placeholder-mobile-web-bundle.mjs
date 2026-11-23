// Writes a minimal valid out/mobile-web bundle for non-qualification CI test lanes that never ship orcad.
import { createRequire } from 'node:module'
import {
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  contentTypeForExtension,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'

const { MOBILE_WEB_BUNDLE_DIR, assertMobileWebBundleBuilt } = createRequire(import.meta.url)(
  '../../desktop-distribution/runtime-verification/verify-packaged-mobile-web-bundle.cjs'
)

export async function writePlaceholderMobileWebBundle(outDir = MOBILE_WEB_BUNDLE_DIR) {
  const bytes = Buffer.from('<!doctype html><meta charset="utf-8"><title>Orca</title>\n', 'utf8')
  const [desktopVersion, protocolWindow] = await Promise.all([
    readDesktopVersion(),
    readProtocolWindow()
  ])
  const result = await writeMobileWebBundleTree({
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
    desktopVersion,
    protocolWindow
  })
  assertMobileWebBundleBuilt(outDir)
  return result
}

if (isDirectInvocation(import.meta.url)) {
  await writePlaceholderMobileWebBundle()
}
