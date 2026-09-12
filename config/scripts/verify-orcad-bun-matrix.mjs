#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  orcadBunRuntimeFilename,
  orcadArtifactHashPrefix,
  ORCAD_VERSION,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'
import { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'
import { inspectNativeExecutable } from './native-executable-format.mjs'

const root = resolve(import.meta.dirname, '../..')

export async function verifyOrcadBunMatrix(matrixRoot) {
  const targetResults = []
  for (const target of ORCAD_BUN_TARGETS) {
    targetResults.push(await verifyTarget(resolve(matrixRoot), target))
  }
  return { ok: true, matrixRoot: resolve(matrixRoot), targets: targetResults }
}

export async function computeOrcadArtifactVersion(artifactDir, browserName) {
  const target = readFileSync(join(artifactDir, ORCAD_BUILD_TARGET_FILENAME), 'utf8').trim()
  const hash = createHash('sha256').update(orcadArtifactHashPrefix(target))
  for (const filename of orcadArtifactFilenames(target)) {
    await hashFileInto(hash, join(artifactDir, filename))
  }
  if (browserName) {
    await hashFileInto(hash, join(artifactDir, browserName))
  }
  return `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}

export function verifyOrcadArtifactTarget(artifactDir, target) {
  const recordedTarget = readFileSync(join(artifactDir, ORCAD_BUILD_TARGET_FILENAME), 'utf8').trim()
  if (recordedTarget !== target) {
    throw new Error(`${target} artifact records build target ${recordedTarget || 'empty'}`)
  }
}

async function verifyTarget(matrixRoot, target) {
  const artifactDir = join(matrixRoot, target)
  const [platform, arch] = target.split('-')
  const browserName = orcadAgentBrowserNativeName(
    platform,
    arch,
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const sourceBrowser = join(root, 'node_modules', 'agent-browser', 'bin', browserName)
  const expectedBrowserName = existsSync(sourceBrowser) ? browserName : null
  const expectedFiles = new Set([
    ...orcadArtifactFilenames(target),
    ORCAD_VERSION_FILENAME,
    ...(expectedBrowserName ? [expectedBrowserName] : [])
  ])
  const actualFiles = listFiles(artifactDir)
  const missing = [...expectedFiles].filter((filename) => !actualFiles.has(filename))
  const unexpected = [...actualFiles].filter((filename) => !expectedFiles.has(filename))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${target} artifact inventory mismatch; missing=${missing.join(',') || 'none'} ` +
        `unexpected=${unexpected.join(',') || 'none'}`
    )
  }
  let totalBytes = 0
  for (const filename of expectedFiles) {
    const size = statSync(join(artifactDir, filename)).size
    if (size === 0) {
      throw new Error(`${target} artifact ${filename} is empty`)
    }
    totalBytes += size
  }

  const version = readFileSync(join(artifactDir, ORCAD_VERSION_FILENAME), 'utf8').trim()
  verifyOrcadArtifactTarget(artifactDir, target)
  const recomputedVersion = await computeOrcadArtifactVersion(artifactDir, expectedBrowserName)
  if (version !== recomputedVersion) {
    throw new Error(
      `${target} version mismatch: recorded=${version} recomputed=${recomputedVersion}`
    )
  }
  const runtimePath = join(artifactDir, orcadBunRuntimeFilename(target))
  const runtimeSha256 = await fileSha256(runtimePath)
  if (runtimeSha256 !== ORCAD_BUN_RELEASE_ASSETS[target].executableSha256) {
    throw new Error(`${target} Bun runtime checksum mismatch`)
  }
  const runtime = inspectNativeExecutable(runtimePath)
  const watcher = inspectNativeExecutable(
    join(artifactDir, 'node_modules', '@parcel', 'watcher', 'watcher.node')
  )
  const expectedFormat = platform === 'darwin' ? 'macho' : platform === 'linux' ? 'elf' : 'pe'
  for (const [label, identity] of [
    ['runtime', runtime],
    ['watcher', watcher]
  ]) {
    if (identity.format !== expectedFormat || identity.arch !== arch) {
      throw new Error(
        `${target} ${String(label)} is ${identity.format}/${identity.arch}, expected ${expectedFormat}/${arch}`
      )
    }
  }
  if (platform === 'linux') {
    const expectedLoader = target.endsWith('-musl') ? 'ld-musl-' : 'ld-linux-'
    if (!runtime.interpreter?.includes(expectedLoader)) {
      throw new Error(
        `${target} runtime loader is ${runtime.interpreter ?? 'absent'}, expected ${expectedLoader}`
      )
    }
    if (watcher.interpreter !== null) {
      throw new Error(`${target} watcher unexpectedly declares an executable interpreter`)
    }
  }
  return {
    target,
    version,
    totalBytes,
    runtimeSha256,
    runtimeFormat: formatLabel(runtime),
    watcherFormat: formatLabel(watcher),
    browserName: expectedBrowserName
  }
}

function listFiles(dir) {
  const files = new Set()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      files.add(relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    }
  }
  return files
}

function formatLabel(identity) {
  return [identity.format, identity.arch, identity.interpreter].filter(Boolean).join(' / ')
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  await hashFileInto(hash, path)
  return hash.digest('hex')
}

async function hashFileInto(hash, path) {
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

if (process.argv[1]?.endsWith('verify-orcad-bun-matrix.mjs')) {
  try {
    const result = await verifyOrcadBunMatrix(
      argument('--root') ?? join(root, 'out', 'orcad-matrix')
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    console.error(
      `[verify-orcad-bun-matrix] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  }
}
