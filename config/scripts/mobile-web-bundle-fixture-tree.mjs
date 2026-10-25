import {
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  contentTypeForExtension,
  hashedAsset,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'

// Use real manifest writer with tiny assets: packaging guard judges manifest/bytes, so full mobile build adds unrelated dependency failures and cost.
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
  // Provide script/style/image assets used by guard cases; missing type would throw undefined.path instead of testing rule.
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
