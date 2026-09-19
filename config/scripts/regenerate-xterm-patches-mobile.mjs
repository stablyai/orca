#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { regenerateXtermPatches } from './regenerate-xterm-patches.mjs'
import { splitPatchEntries } from './xterm-patch-text.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const MOBILE_SOURCES = ['src/browser/ColorContrastCache.ts', 'src/common/buffer/BufferLine.ts']

export function mobileXtermPatchProfile(manifest, mobilePackage, desktopSource) {
  const coreEntries = manifest.packages.filter((entry) => entry.name === '@xterm/xterm')
  if (coreEntries.length !== 1) {
    throw new Error('Expected exactly one pinned @xterm/xterm package in the upstream manifest')
  }
  const core = coreEntries[0]
  if (mobilePackage.dependencies['@xterm/xterm'] !== core.version) {
    throw new Error(`Mobile @xterm/xterm must pin the upstream manifest version ${core.version}`)
  }
  const entries = splitPatchEntries(desktopSource).filter((entry) =>
    MOBILE_SOURCES.includes(entry.path)
  )
  for (const source of MOBILE_SOURCES) {
    if (entries.filter((entry) => entry.path === source).length !== 1) {
      throw new Error(`Expected exactly one ${source} source stanza`)
    }
  }
  const filename = `@xterm__xterm@${core.version}`
  return {
    source: entries.map((entry) => entry.text).join(''),
    manifest: {
      ...manifest,
      packages: [
        {
          ...core,
          sourcePatch: `mobile/patches/xterm-src/${filename}.src.patch`,
          patch: `mobile/patches/${filename}.patch`
        }
      ]
    }
  }
}

export function regenerateMobileXtermPatch({
  mode,
  repoRoot = REPO_ROOT,
  workDir = path.join(tmpdir(), 'orca-mobile-xterm-patch-build')
}) {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'config', 'patches', 'xterm-upstream.json'), 'utf8')
  )
  const core = manifest.packages.find((entry) => entry.name === '@xterm/xterm')
  if (!core) {
    throw new Error('Missing pinned @xterm/xterm package in the upstream manifest')
  }
  const profile = mobileXtermPatchProfile(
    manifest,
    JSON.parse(readFileSync(path.join(repoRoot, 'mobile', 'package.json'), 'utf8')),
    readFileSync(path.join(repoRoot, core.sourcePatch), 'utf8')
  )
  const sourcePath = path.join(repoRoot, profile.manifest.packages[0].sourcePatch)
  if (mode === 'write') {
    mkdirSync(path.dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, profile.source)
  } else if (readFileSync(sourcePath, 'utf8') !== profile.source) {
    throw new Error('Mobile xterm source drifted; run regenerate-xterm-patches-mobile.mjs --write')
  }
  regenerateXtermPatches({
    mode,
    repoRoot,
    workDir,
    manifest: profile.manifest,
    lockfileRelativePath: path.join('mobile', 'pnpm-lock.yaml')
  })
}

function main(argv) {
  const known = (value) => ['--write', '--check'].includes(value) || value.startsWith('--work-dir=')
  if (argv.some((value) => !known(value))) {
    throw new Error(
      'Usage: regenerate-xterm-patches-mobile.mjs [--check | --write] [--work-dir=<path>]'
    )
  }
  if (argv.includes('--write') && argv.includes('--check')) {
    throw new Error('Pass either --write or --check, not both')
  }
  const workDir = argv.find((value) => value.startsWith('--work-dir='))
  regenerateMobileXtermPatch({
    mode: argv.includes('--write') ? 'write' : 'check',
    ...(workDir ? { workDir: path.resolve(workDir.slice('--work-dir='.length)) } : {})
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`\n${error.message}\n`)
    process.exit(1)
  }
}
