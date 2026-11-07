#!/usr/bin/env node
// Stamps each macOS update manifest with the app's minimum macOS so the updater on an older
// macOS stays on its last compatible build instead of installing one that will not launch.
// Usage: node gate-mac-update-manifests.mjs <dist-dir>
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { darwinVersionForMacos } from '../../../../src/shared/macos-darwin-floor.ts'

export function withMinimumSystemVersion(manifest, darwinVersion) {
  const lines = manifest
    .replace(/\n+$/, '')
    .split('\n')
    .filter((line) => !line.startsWith('minimumSystemVersion:'))
  lines.push(`minimumSystemVersion: ${darwinVersion}`)
  return `${lines.join('\n')}\n`
}

function readMinimumMacosVersion(distDir) {
  const versions = new Set()
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac')) {
      continue
    }
    for (const app of readdirSync(join(distDir, entry.name))) {
      if (!app.endsWith('.app')) {
        continue
      }
      const plist = join(distDir, entry.name, app, 'Contents', 'Info.plist')
      versions.add(
        execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', plist], {
          encoding: 'utf8'
        }).trim()
      )
    }
  }
  if (versions.size !== 1) {
    throw new Error(
      `Expected one LSMinimumSystemVersion across ${distDir}, found ${[...versions].join(', ')}`
    )
  }
  return [...versions][0]
}

function main(distDir) {
  const macosVersion = readMinimumMacosVersion(distDir)
  const darwinVersion = darwinVersionForMacos(macosVersion)
  const manifests = readdirSync(distDir).filter((name) => name.endsWith('-mac.yml'))
  if (manifests.length === 0) {
    throw new Error(`No *-mac.yml manifest in ${distDir}`)
  }
  for (const name of manifests) {
    const path = join(distDir, name)
    writeFileSync(path, withMinimumSystemVersion(readFileSync(path, 'utf8'), darwinVersion))
    console.log(`${name}: minimumSystemVersion ${darwinVersion} (macOS ${macosVersion})`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (!process.argv[2]) {
    console.error('Usage: node gate-mac-update-manifests.mjs <dist-dir>')
    process.exit(1)
  }
  main(process.argv[2])
}
