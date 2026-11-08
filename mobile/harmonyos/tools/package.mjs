#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sourceFiles } from './source-manifest.mjs'

const root = join(import.meta.dirname, '..')
const output = join(root, 'dist')
mkdirSync(output, { recursive: true })
const args = process.argv.slice(2)
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sources = sourceFiles(root)
const sourceHash = createHash('sha256')
for (const name of sources) {
  sourceHash.update(`${name}\0${hash(join(root, name))}\n`)
}
if (args.includes('--source')) {
  const staging = join(output, 'source', 'orca-harmonyos')
  rmSync(staging, { recursive: true, force: true })
  for (const name of sources) {
    mkdirSync(dirname(join(staging, name)), { recursive: true })
    copyFileSync(join(root, name), join(staging, name))
  }
  const archive = join(output, 'orca-harmonyos-source.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', join(output, 'source'), 'orca-harmonyos'])
  writeFileSync(
    join(output, 'source-manifest.json'),
    `${JSON.stringify({ sha256: sourceHash.digest('hex'), files: sources }, null, 2)}\n`
  )
  writeFileSync(`${archive}.sha256`, `${hash(archive)}  orca-harmonyos-source.tar.gz\n`)
  console.log('Source package: dist/orca-harmonyos-source.tar.gz (local signing excluded).')
} else if (args.includes('--hap')) {
  const input = resolve(root, args[args.indexOf('--hap') + 1])
  if (!input.endsWith('.hap')) {
    throw new Error('Expected a HAP artifact')
  }
  const signed = input.endsWith('-signed.hap')
  const modeIndex = args.indexOf('--build-mode')
  const buildMode = modeIndex === -1 ? 'debug' : args[modeIndex + 1]
  const name = `orca-harmonyos-${buildMode}-${signed ? 'signed' : 'unsigned'}.hap`
  copyFileSync(input, join(output, name))
  const report = {
    artifact: name,
    signed,
    buildMode,
    sha256: hash(input),
    bytes: statSync(input).size,
    sourceSha256: sourceHash.digest('hex'),
    sdkApi: 26,
    node: process.version,
    host: process.platform
  }
  writeFileSync(join(output, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(output, `${name}.sha256`), `${report.sha256}  ${name}\n`)
  console.log(
    `HAP: dist/${name} (${signed ? 'signed; verify the device provisioning profile before installing' : 'unsigned; simulator only'})`
  )
} else {
  throw new Error(
    'Usage: node tools/package.mjs --source | --hap <file> [--build-mode debug|release]'
  )
}
