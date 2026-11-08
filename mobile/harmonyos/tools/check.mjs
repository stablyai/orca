#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceFiles } from './source-manifest.mjs'

const root = join(import.meta.dirname, '..')
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Use Node 24 or newer.')
}
for (const name of sourceFiles(root)) {
  if (!/\.(?:md|ets|mjs|cjs|ts|json5?|sh)$/.test(name) || name.includes('/vendor/')) {
    continue
  }
  const text = readFileSync(join(root, name), 'utf8')
  if (
    /(?:github_pat_|ghp_)[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:keyPassword|storePassword)"\s*:\s*"[^"]+"/.test(
      text
    )
  ) {
    throw new Error(`Credential-like content in source: ${name}`)
  }
}
for (const command of [
  ['tools/prepare-vendor.mjs', '--check'],
  ['--disable-warning=ExperimentalWarning', 'tools/verify/review-regressions.cjs'],
  ['--disable-warning=ExperimentalWarning', 'tools/verify/crypto-mirror.mjs']
]) {
  const result = spawnSync(process.execPath, command, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
console.log('Source checks passed. SDK compilation is a separate gate: bash tools/build.sh --clean')
