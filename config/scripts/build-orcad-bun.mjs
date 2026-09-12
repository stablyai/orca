#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import {
  ORCAD_BUN_RELEASE_ASSETS,
  ORCAD_BUN_VERSION,
  orcadBunReleaseUrl
} from '../../src/shared/orcad-bun-runtime.ts'
import { runProcessSync, windowsPowerShellPath } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const cacheRoot = join(root, 'out', '.orcad-bun-runtime', `v${ORCAD_BUN_VERSION}`)

export function currentTarget() {
  if (process.platform === 'darwin') {
    return `darwin-${process.arch}`
  }
  if (process.platform === 'win32') {
    return `win32-${process.arch}`
  }
  if (process.platform !== 'linux') {
    throw new Error(`Unsupported Bun platform: ${process.platform}`)
  }
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime
  return `linux-${process.arch}-${glibc ? 'glibc' : 'musl'}`
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

function run(command, args) {
  const result = runProcessSync({ program: command, args })
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Bun download failed: ${response.status} ${response.statusText}`)
  }
  writeFileSync(destination, new Uint8Array(await response.arrayBuffer()))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function extract(zipPath, destination) {
  if (process.platform === 'win32') {
    run(windowsPowerShellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
    ])
    return
  }
  run('unzip', ['-q', zipPath, '-d', destination])
}

export function bunExecutableName(target) {
  return target.startsWith('win32-') ? 'bun.exe' : 'bun'
}

export function findBunExecutable(rootDir, target) {
  const expected = bunExecutableName(target)
  const entries = readdirSync(rootDir, { recursive: true, withFileTypes: true })
  const entry = entries.find((candidate) => candidate.isFile() && candidate.name === expected)
  if (!entry) {
    throw new Error(`Downloaded archive contained no ${expected}`)
  }
  return join(entry.parentPath, entry.name)
}

function verifyRuntime(path) {
  const result = runProcessSync({ program: path, args: ['--version'] })
  if (result.code !== 0 || result.stdout.trim() !== ORCAD_BUN_VERSION) {
    throw new Error(
      `Expected Bun ${ORCAD_BUN_VERSION} at ${path}, got ${result.stdout.trim() || result.stderr.trim()}`
    )
  }
}

async function materializeRuntime(target, outputPath) {
  const asset = ORCAD_BUN_RELEASE_ASSETS[target]
  if (!asset) {
    throw new Error(`Unsupported Bun target: ${target}`)
  }
  const cached = join(cacheRoot, target, orcadBunRuntimeFilename(target))
  if (existsSync(cached) && sha256(cached) !== asset.executableSha256) {
    rmSync(cached, { force: true })
  }
  if (!existsSync(cached)) {
    const temporary = mkdtempSync(join(tmpdir(), 'orca-bun-download-'))
    try {
      const zipPath = join(temporary, basename(asset.filename))
      await download(orcadBunReleaseUrl(asset), zipPath)
      const actual = sha256(zipPath)
      if (actual !== asset.sha256) {
        throw new Error(`Bun checksum mismatch for ${asset.filename}: ${actual}`)
      }
      const extracted = join(temporary, 'extracted')
      mkdirSync(extracted)
      extract(zipPath, extracted)
      mkdirSync(join(cacheRoot, target), { recursive: true })
      copyFileSync(findBunExecutable(extracted, target), cached)
      if (!target.startsWith('win32-')) {
        chmodSync(cached, 0o755)
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  const executableHash = sha256(cached)
  if (executableHash !== asset.executableSha256) {
    throw new Error(`Bun executable checksum mismatch for ${target}: ${executableHash}`)
  }
  if (target === currentTarget()) {
    verifyRuntime(cached)
  }
  mkdirSync(resolve(outputPath, '..'), { recursive: true })
  if (resolve(cached) !== resolve(outputPath)) {
    copyFileSync(cached, outputPath)
  }
  if (!target.startsWith('win32-')) {
    chmodSync(outputPath, 0o755)
  }
}

async function main() {
  const target = argument('--target') ?? currentTarget()
  const outputDir = argument('--out-dir')
  const cachedRuntimePath = join(cacheRoot, target, orcadBunRuntimeFilename(target))
  const runtimePath =
    process.argv.includes('--runtime-only') && outputDir
      ? join(resolve(outputDir), orcadBunRuntimeFilename(target))
      : cachedRuntimePath
  await materializeRuntime(target, runtimePath)

  if (process.argv.includes('--runtime-only')) {
    process.stdout.write(`${runtimePath}\n`)
    return
  }
  const result = runProcessSync({
    program: process.execPath,
    args: [join(root, 'config/scripts/build-orcad.mjs')],
    cwd: root,
    env: {
      ...process.env,
      ORCAD_BUILD_TARGET: target,
      ORCAD_BUILD_TARGET_IS_CURRENT: target === currentTarget() ? '1' : '0',
      ORCAD_BUN_RUNTIME_PATH: runtimePath,
      ...(outputDir ? { ORCAD_OUT_DIR: resolve(outputDir) } : {})
    },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    process.exit(result.code ?? 1)
  }
}

if (process.argv[1]?.endsWith('build-orcad-bun.mjs')) {
  await main()
}
