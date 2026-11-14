// Regenerate re-signed NSIS installer blockmap in gzip format via app-builder-lib’s JS buildBlockMap; electron-builder 26 removed app-builder-bin’s Go binary.
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
