#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runProcessSync } from './script-child-process.mjs'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--artifact-dir' || args[2] !== '--arch') {
  throw new Error(
    'Usage: orcad-bun-glibc-floor-smoke.mjs --artifact-dir <directory> --arch <arm64|x64>'
  )
}
const artifactDir = realpathSync(resolve(args[1]))
const arch = args[3]
if (!['arm64', 'x64'].includes(arch)) {
  throw new Error('Expected --arch arm64 or x64')
}
for (const file of [
  'bun-runtime',
  'orcad.js',
  'node_modules/@parcel/watcher/index.js',
  'node_modules/@parcel/watcher/watcher.node'
]) {
  if (!existsSync(join(artifactDir, file))) {
    throw new Error(`Artifact is missing ${file}`)
  }
}
const root = realpathSync(resolve(import.meta.dirname, '../..'))
// Pin platform manifests to avoid cross-platform digest collisions in classic Docker storage.
const imageDigests = {
  arm64: '722ea796ac2d57eeb3627c58a582fc1acc58be51faf815e1bce1682ae5c092f7',
  x64: 'c664f8f86ed5a386b0a340d981b8f81714e21a8b9c73f658c4bea56aa179d54a'
}
const image = `ubuntu@sha256:${imageDigests[arch]}`
const probe = `
set -eu
test "$(getconf GNU_LIBC_VERSION)" = 'glibc 2.31'
! command -v node
! command -v npm
/artifact/bun-runtime -e 'const [major, minor] = Bun.version.split(".").map(Number); if (major < 1 || (major === 1 && minor < 4) || process.arch !== process.env.ORCAD_FLOOR_ARCH) process.exit(1); console.log(JSON.stringify({bun: Bun.version, arch: process.arch, glibc: "2.31", node: false, npm: false}))'
/artifact/bun-runtime /artifact/orcad.js --orcad-smoke-load-check
/artifact/bun-runtime config/scripts/orcad-bun-native-packages-smoke.mjs
/artifact/bun-runtime config/scripts/orcad-bun-pty-poc.mjs --cycles 25
`
const result = runProcessSync({
  program: 'docker',
  args: [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--platform',
    `linux/${arch === 'x64' ? 'amd64' : 'arm64'}`,
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=256m',
    '--mount',
    `type=bind,source=${artifactDir},target=/artifact,readonly`,
    '--mount',
    `type=bind,source=${root},target=/workspace,readonly`,
    '--workdir',
    '/workspace',
    '--env',
    'ORCAD_NATIVE_ARTIFACT_DIR=/artifact',
    '--env',
    `ORCAD_FLOOR_ARCH=${arch}`,
    image,
    '/bin/sh',
    '-c',
    probe
  ],
  timeoutMs: 120_000
})
if (result.stdout) {
  process.stdout.write(result.stdout)
}
if (result.stderr) {
  process.stderr.write(result.stderr)
}
if (result.code !== 0) {
  throw new Error(`glibc-floor smoke failed (${result.code})`)
}
