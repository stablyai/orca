#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sharedTreeStagingPath } from '../../artifact-storage/atomic-publication/shared-tree-publish.mjs'
import { ensureIrohPrebuild } from './ensure-iroh-prebuild.mjs'
import { IROH_BUILD_IDENTITY, IROH_PREBUILD_FILES, verifyIrohPrebuild } from './iroh-prebuild.mjs'
import { readManifest } from './orcad-prebuild-slot-contents.mjs'

const ROOT = resolve(import.meta.dirname, '../../../..')
const PREPARE_COMMAND = 'node config/scripts/orcad-distribution/prebuilds/stage-source-iroh.mjs'

/** Publish qualified current-host bytes only in this checkout; checks never build or write. */
export async function ensureSourceIrohRuntime({
  root = ROOT,
  prebuildsDir = process.env.ORCAD_PREBUILDS_DIR || join(root, 'out', 'orcad-prebuilds'),
  platform = process.platform,
  arch = process.arch,
  libc = platform === 'linux'
    ? process.report?.getReport()?.header?.glibcVersionRuntime
      ? 'glibc'
      : 'musl'
    : undefined,
  checkOnly = false,
  provision = true
} = {}) {
  const slot = `${platform}-${arch}${platform === 'linux' ? `-${libc}` : ''}`
  // Intel macOS has no patched SDK lane; Iroh remains optional for unrelated startup.
  if (slot === 'darwin-x64') {
    return null
  }
  try {
    if (!Object.hasOwn(IROH_PREBUILD_FILES, slot)) {
      throw new Error(`Unsupported source Iroh host: ${slot}`)
    }
    root = realpathSync(root)
    const packageDir = checkoutPackageDir(root)
    prebuildsDir = resolve(prebuildsDir)
    if (provision && !checkOnly) {
      await ensureIrohPrebuild({ targetPlatform: platform, arch, libc, root, prebuildsDir })
    }
    const version = JSON.parse(
      readFileSync(join(root, 'node_modules', '@number0', 'iroh', 'package.json'), 'utf8')
    ).version
    const entry = readManifest(prebuildsDir)?.slots?.[slot]
    const source = verifyIrohPrebuild({
      slotDir: join(prebuildsDir, slot),
      slot,
      entry,
      version
    })
    const hash = entry.files[IROH_PREBUILD_FILES[slot]]
    const main = `./native-${hash}.node`
    const metadata = `${JSON.stringify({ name: '@number0/iroh', version: IROH_BUILD_IDENTITY.sdkVersion, main }, null, 2)}\n`
    const nativePath = join(packageDir, main)
    const packageJson = join(packageDir, 'package.json')
    if (checkOnly) {
      assertNativeHash(nativePath, hash)
      assertRegularFile(packageJson)
      if (readFileSync(packageJson, 'utf8') !== metadata) {
        throw new Error(`Stale source Iroh package at ${packageJson}`)
      }
      return { slot, packageDir, nativePath }
    }
    mkdirSync(packageDir, { recursive: true })

    // Hash-named addons are never replaced: another process may already have one loaded.
    if (statIfPresent(nativePath)) {
      assertNativeHash(nativePath, hash)
    } else {
      const temporary = sharedTreeStagingPath(nativePath)
      try {
        writeFileSync(temporary, readFileSync(source), { flag: 'wx' })
        assertNativeHash(temporary, hash)
        try {
          linkSync(temporary, nativePath)
        } catch (error) {
          if (error.code !== 'EEXIST') {
            throw error
          }
          assertNativeHash(nativePath, hash)
        }
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    if (statIfPresent(packageJson)) {
      assertRegularFile(packageJson)
      if (readFileSync(packageJson, 'utf8') === metadata) {
        return { slot, packageDir, nativePath }
      }
    }
    const temporary = sharedTreeStagingPath(packageJson)
    try {
      writeFileSync(temporary, metadata, { flag: 'wx' })
      renameSync(temporary, packageJson)
    } finally {
      rmSync(temporary, { force: true })
    }
    return { slot, packageDir, nativePath }
  } catch (cause) {
    throw new Error(
      `Patched source Iroh unavailable for ${slot}: ${cause.message}. ` +
        `Run \`${PREPARE_COMMAND}\` on the matching host outside the pinned FHS environment ` +
        '(GNU Linux requires working Docker for the pinned manylinux 2.28 producer), then rerun dev/tests inside FHS. ' +
        'No stock SDK fallback is allowed.',
      { cause }
    )
  }
}

/** Reject symlinked output ancestors rather than following them into another checkout or pnpm. */
function checkoutPackageDir(root) {
  let directory = root
  for (const part of ['out', 'node_modules', '@number0', 'iroh']) {
    directory = join(directory, part)
    const stat = statIfPresent(directory)
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Source Iroh output must be a checkout-owned directory: ${directory}`)
      }
    }
  }
  return directory
}

function statIfPresent(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function assertRegularFile(path) {
  const stat = statIfPresent(path)
  if (!stat) {
    throw new Error(`Source Iroh output is missing: ${path}`)
  }
  if (!stat.isFile()) {
    throw new Error(`Source Iroh output must be a regular file: ${path}`)
  }
}

function assertNativeHash(path, expected) {
  assertRegularFile(path)
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
    throw new Error(
      `Immutable source Iroh native hash mismatch at ${path}; refusing to overwrite it`
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log(
      `Usage: ${PREPARE_COMMAND} [--check-only]\nPrepare the qualified current-host SDK outside FHS, then rerun dev/tests.`
    )
  } else {
    try {
      const result = await ensureSourceIrohRuntime({
        checkOnly: process.argv.includes('--check-only')
      })
      console.log(
        result
          ? `[source-iroh] Ready: ${result.nativePath}`
          : '[source-iroh] Iroh is unavailable on darwin-x64.'
      )
    } catch (error) {
      console.error(`[source-iroh] ${error.message}`)
      process.exitCode = 1
    }
  }
}
