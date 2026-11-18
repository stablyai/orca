#!/usr/bin/env node
// Copies what the updater needs (manifests and every file they name, with blockmaps) into one
// folder under Zotz names, rewriting the manifests to match, see docs/zotz/UPDATES-SPEC.md §4.
// The build keeps upstream's orca-* artifact names because upstream CI reads them.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
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
 * Each matched file is published only under its release name, also where a manifest names it.
 */
export function stageZotzReleaseAssets({ distDir, outDir, humanCopies }) {
  mkdirSync(outDir, { recursive: true })
  const distFiles = readdirSync(distDir)
  const renames = new Map()
  for (const line of humanCopies.split('\n')) {
    const [pattern, releaseName] = line.split('=').map((part) => part?.trim())
    if (!pattern || !releaseName) {
      continue
    }
    const matcher = new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '.*')}$`)
    const match = distFiles.find((name) => matcher.test(name))
    if (!match) {
      throw new Error(`Missing build output: ${pattern}`)
    }
    renames.set(match, releaseName)
  }
  const releaseName = (name) => renames.get(name) ?? name
  const manifests = distFiles.filter((name) => /^latest(-[a-z0-9-]+)?\.yml$/.test(name))
  if (manifests.length === 0) {
    throw new Error(`No updater manifest (latest*.yml) in ${distDir}`)
  }
  for (const manifest of manifests) {
    let text = readFileSync(join(distDir, manifest), 'utf8')
    for (const name of filesNamedByManifest(text)) {
      copyInto(join(distDir, name), join(outDir, releaseName(name)))
      const blockmap = join(distDir, `${name}.blockmap`)
      if (existsSync(blockmap)) {
        copyInto(blockmap, join(outDir, `${releaseName(name)}.blockmap`))
      }
      text = text.replaceAll(name, releaseName(name))
    }
    writeFileSync(join(outDir, manifest), text)
    console.log(`staged ${manifest}`)
  }
  for (const [name, target] of renames) {
    if (!existsSync(join(outDir, target))) {
      copyInto(join(distDir, name), join(outDir, target))
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  stageZotzReleaseAssets({
    distDir: 'dist',
    outDir: 'release',
    humanCopies: process.env.ZOTZ_HUMAN_ASSETS ?? ''
  })
}
