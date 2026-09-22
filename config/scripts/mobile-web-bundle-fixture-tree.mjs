import {
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  contentTypeForExtension,
  hashedAsset,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'

/**
 * A small, real bundle tree for the suites that test the packaging guard rather than the page.
 *
 * The guard reads a manifest and the bytes beside it; what those bytes are is not its business.
 * Building the app bundle to get them would make every one of those cases pay for esbuild over
 * the whole mobile graph, and would fail for a reason that has nothing to do with the guard on any
 * machine where mobile's dependencies are absent.
 *
 * Real rather than hand-written: it goes through the same manifest writer the page does, so a
 * change to the manifest shape reaches these suites instead of leaving them asserting a shape
 * nothing produces any more.
 */
/** A 1x1 transparent PNG, the smallest real image the content-type rule accepts. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

export async function writeMobileWebBundleFixtureTree({ outDir, body = 'fixture' }) {
  const [desktopVersion, protocolWindow] = await Promise.all([
    readDesktopVersion(),
    readProtocolWindow()
  ])
  // One asset per content type the guard's own cases reach for by extension: a script, a
  // stylesheet and an image. Fewer would make those cases read `undefined.path` rather than fail.
  const script = hashedAsset(
    Buffer.from(`globalThis.orca = ${JSON.stringify(body)}\n`, 'utf8'),
    'js'
  )
  const stylesheet = hashedAsset(Buffer.from(`:root{--orca:${body}}\n`, 'utf8'), 'css')
  const image = hashedAsset(PIXEL_PNG, 'png')
  const indexBytes = Buffer.from(
    `<!doctype html><meta charset="utf-8">` +
      `<link rel="stylesheet" href="/${stylesheet.path}">` +
      `<img src="/${image.path}" alt="">` +
      `<script src="/${script.path}"></script>\n`,
    'utf8'
  )
  return writeMobileWebBundleTree({
    outDir,
    written: [
      {
        bytes: indexBytes,
        path: MOBILE_WEB_BUNDLE_ENTRYPOINT,
        sha256: sha256Hex(indexBytes),
        byteLength: indexBytes.byteLength,
        contentType: contentTypeForExtension('html')
      },
      script,
      stylesheet,
      image
    ],
    desktopVersion,
    protocolWindow
  })
}
