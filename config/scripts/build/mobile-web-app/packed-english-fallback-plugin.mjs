import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const catalogPath = fileURLToPath(
  new URL('../../../../mobile/src/i18n/en-runtime-required.json', import.meta.url)
)

// The page needs this fallback before it can ask the paired host for a catalog.
export const packedEnglishFallbackPlugin = {
  name: 'orca-packed-english-fallback',
  setup(build) {
    build.onLoad({ filter: /[\\/]en-runtime-required\.json$/ }, async ({ path }) => {
      if (path !== catalogPath) {
        return undefined
      }
      const catalog = JSON.stringify(JSON.parse(await readFile(path, 'utf8')))
      const packed = gzipSync(catalog, { level: 9 }).toString('base64')
      return {
        contents: `import { gunzipSync, strFromU8 } from 'fflate'
import { decodeBase64Bytes } from '../transport/encryption/base64-byte-codec'
export default JSON.parse(strFromU8(gunzipSync(decodeBase64Bytes(${JSON.stringify(packed)}))))`,
        loader: 'js',
        resolveDir: dirname(path)
      }
    })
  }
}
