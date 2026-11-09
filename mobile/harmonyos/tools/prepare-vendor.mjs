#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const check = process.argv.includes('--check')
const provenance = JSON.parse(readFileSync(join(root, 'tools/vendor/manifest.json'), 'utf8'))
for (const [name, expected] of Object.entries(provenance.sha256)) {
  const actual = createHash('sha256')
    .update(readFileSync(join(root, name)))
    .digest('hex')
  if (actual !== expected) {
    throw new Error(`Pinned vendor source changed: ${name}`)
  }
}
const uiAssets = JSON.parse(
  readFileSync(join(root, 'entry/src/main/resources/rawfile/licenses/UI_ASSETS.json'), 'utf8')
)
for (const file of uiAssets.files) {
  const actual = createHash('sha256')
    .update(readFileSync(join(root, file.path)))
    .digest('hex')
  if (actual !== file.sha256) {
    throw new Error(`Pinned UI asset changed: ${file.path}`)
  }
}
const nacl = readFileSync(join(root, 'tools/vendor/tweetnacl/nacl-fast.min.js'), 'utf8')
const cryptoNeedle = 'o=require("crypto")'
const invocation =
  '}("undefined"!=typeof module&&module.exports?module.exports:self.nacl=self.nacl||{});'
if (!nacl.includes(cryptoNeedle) || !nacl.includes(invocation)) {
  throw new Error('Unexpected TweetNaCl input')
}
const patched = `const naclDefault = {};\n${nacl.replace(cryptoNeedle, 'o=null').replace(invocation, '}(naclDefault);')}\nmodule.exports = naclDefault;\n`
const generated = new Map([
  ['entry/src/main/ets/vendor/nacl-fast.min.js', Buffer.from(patched)],
  [
    'entry/src/main/ets/vendor/fflate-umd.js',
    readFileSync(join(root, 'tools/vendor/fflate/fflate-umd.js'))
  ]
])
const notices = `${[
  'LICENSE',
  'tools/vendor/tweetnacl/LICENSE',
  'tools/vendor/fflate/LICENSE',
  'tools/vendor/fflate/UMD-LICENSE',
  'entry/src/main/resources/rawfile/licenses/Geist-OFL.txt',
  'entry/src/main/resources/rawfile/licenses/Lucide-ISC.txt'
]
  .map((name) => `${name}\n\n${readFileSync(join(root, name), 'utf8')}`)
  .join('\n\n')
  .trimEnd()}\n`
generated.set(
  'entry/src/main/resources/rawfile/licenses/THIRD_PARTY_NOTICES.txt',
  Buffer.from(notices)
)
for (const [name, expected] of generated) {
  const target = join(root, name)
  if (check) {
    if (!readFileSync(target).equals(expected)) {
      throw new Error(`Regenerate vendor output: node tools/prepare-vendor.mjs (${name})`)
    }
  } else {
    writeFileSync(target, expected)
  }
}
console.log(check ? 'Vendor outputs match pinned sources.' : 'Prepared ArkTS vendor modules.')
