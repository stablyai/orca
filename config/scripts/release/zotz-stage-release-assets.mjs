#!/usr/bin/env node
// Copies what the updater needs (manifests and every file they name, with blockmaps) plus
// human-named installer copies into one folder, see docs/zotz/UPDATES-SPEC.md §4.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** @param {string} manifestText */
export function filesNamedByManifest(manifestText) {
  const manifest = parse(manifestText) ?? {}
  const names = new Set()
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    if (typeof entry?.url === 'string') {
      names.add(entry.url)
    }
  }
  if (typeof manifest.path === 'string') {
    names.add(manifest.path)
  }
  return [...names]
}

function copyInto(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Missing build output: ${source}`)
  }
  copyFileSync(source, target)
  console.log(`staged ${basename(target)}`)
}

/**
 * @param {{ distDir: string, outDir: string, humanCopies: string }} options
 * humanCopies: lines of `<file in dist>=<release name>`, e.g. `orca-windows-setup.exe=zotz-windows-x64-setup.exe`.
 */
export function stageZotzReleaseAssets({ distDir, outDir, humanCopies }) {
  mkdirSync(outDir, { recursive: true })
  const manifests = readdirSync(distDir).filter((name) => /^latest(-[a-z0-9-]+)?\.yml$/.test(name))
  if (manifests.length === 0) {
    throw new Error(`No updater manifest (latest*.yml) in ${distDir}`)
  }
  for (const manifest of manifests) {
    copyInto(join(distDir, manifest), join(outDir, manifest))
    for (const name of filesNamedByManifest(readFileSync(join(distDir, manifest), 'utf8'))) {
      copyInto(join(distDir, name), join(outDir, name))
      const blockmap = join(distDir, `${name}.blockmap`)
      if (existsSync(blockmap)) {
        copyInto(blockmap, join(outDir, `${name}.blockmap`))
      }
    }
  }
  for (const line of humanCopies.split('\n')) {
    const [pattern, releaseName] = line.split('=').map((part) => part?.trim())
    if (!pattern || !releaseName) {
      continue
    }
    const matcher = new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '.*')}$`)
    const match = readdirSync(distDir).find((name) => matcher.test(name))
    if (!match) {
      throw new Error(`Missing build output: ${pattern}`)
    }
    copyInto(join(distDir, match), join(outDir, releaseName))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  stageZotzReleaseAssets({
    distDir: 'dist',
    outDir: 'release',
    humanCopies: process.env.ZOTZ_HUMAN_ASSETS ?? ''
  })
}
