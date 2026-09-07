// Regenerate the electron-updater `.blockmap` for a (re-signed) Windows installer.
// electron-builder 26 dropped the app-builder-bin Go binary; blockmap generation
// now lives in app-builder-lib's pure-JS `buildBlockMap`. Mirrors createBlockmap's
// "gzip" format for the standalone NSIS installer blockmap.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: generate-windows-blockmap.mjs <input.exe> <output.exe.blockmap>')
  process.exit(1)
}

const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')

const info = await buildBlockMap(input, 'gzip', output)
console.log(`blockmap written: ${output} (installer sha512=${info.sha512}, size=${info.size})`)
