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
function fingerprintAt(directory, files) {
  const digest = createHash('sha256')
  for (const name of files) {
    digest.update(`${name}\0${hash(join(directory, name))}\n`)
  }
  return digest.digest('hex')
}
const fingerprint = fingerprintAt(root, sources)
if (args.includes('--fingerprint')) {
  console.log(fingerprint)
  process.exit(0)
}
if (args.includes('--source')) {
  const staging = join(output, 'source', 'orca-harmonyos')
  rmSync(staging, { recursive: true, force: true })
  for (const name of sources) {
    mkdirSync(dirname(join(staging, name)), { recursive: true })
    copyFileSync(join(root, name), join(staging, name))
  }
  if (
    fingerprintAt(staging, sources) !== fingerprint ||
    fingerprintAt(root, sourceFiles(root)) !== fingerprint
  ) {
    throw new Error('Source changed during export. Retry from a stable snapshot.')
  }
  const archive = join(output, 'orca-harmonyos-source.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', join(output, 'source'), 'orca-harmonyos'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  })
  writeFileSync(
    join(output, 'source-manifest.json'),
    `${JSON.stringify({ sha256: fingerprint, files: sources }, null, 2)}\n`
  )
  writeFileSync(`${archive}.sha256`, `${hash(archive)}  orca-harmonyos-source.tar.gz\n`)
  console.log('Source package: dist/orca-harmonyos-source.tar.gz (local signing excluded).')
} else if (args.includes('--hap')) {
  const input = resolve(root, args[args.indexOf('--hap') + 1])
  if (!input.endsWith('.hap')) {
    throw new Error('Expected a HAP artifact')
  }
  const expectedIndex = args.indexOf('--source-fingerprint')
  if (expectedIndex !== -1 && args[expectedIndex + 1] !== fingerprint) {
    throw new Error('Source changed after compilation; HAP export refused.')
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
    sourceSha256: fingerprint,
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
    'Usage: node tools/package.mjs --fingerprint | --source | --hap <file> [--build-mode debug|release] [--source-fingerprint <sha256>]'
  )
}
