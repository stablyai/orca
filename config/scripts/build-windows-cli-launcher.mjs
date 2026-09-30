#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function windowsCliLauncherFingerprint(inputPaths, version) {
  const hash = createHash('sha256').update(version)
  for (const inputPath of inputPaths) {
    hash.update('\0').update(readFileSync(inputPath))
  }
  return hash.digest('hex')
}

export function shouldReuseCompiledWindowsCliLauncher(outputPath, fingerprint) {
  const fingerprintPath = `${outputPath}.sha256`
  return (
    existsSync(outputPath) &&
    existsSync(fingerprintPath) &&
    readFileSync(fingerprintPath, 'utf8') === fingerprint
  )
}

/**
 * The four-part numeric version Windows records in the PE. A prerelease suffix
 * survives only in ProductVersion, which is a free-form string.
 */
export function windowsCliLauncherFileVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? '')
  if (!match || match.slice(1).some((part) => Number(part) > 65534)) {
    throw new Error(`Invalid Windows CLI launcher version: ${version}`)
  }
  return `${match.slice(1).join('.')}.0`
}

function defaultOutputPath(projectRoot) {
  return join(projectRoot, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'win32') {
    // Why: electron-builder treats a skipped native build like success and can
    // continue toward a Windows package whose declared orca.exe does not exist.
    throw new Error(
      'Windows CLI launcher compilation requires a Windows host; refusing to package without it.'
    )
  }

  const repoRoot = resolve(import.meta.dirname, '../..')
  const crateRoot = join(repoRoot, 'native', 'windows-cli-launcher')
  const manifestPath = join(crateRoot, 'Cargo.toml')
  const iconPath = join(repoRoot, 'resources', 'build', 'icon.ico')
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  // Throws on a version the PE cannot represent, before anything is compiled.
  windowsCliLauncherFileVersion(version)
  const fingerprint = windowsCliLauncherFingerprint(
    [
      join(crateRoot, 'src', 'main.rs'),
      join(crateRoot, 'build.rs'),
      manifestPath,
      join(crateRoot, 'app.manifest'),
      iconPath,
      join(repoRoot, 'config/scripts/build-windows-cli-launcher.mjs')
    ],
    version
  )
  const outputPath = readArg('--output') ?? defaultOutputPath(repoRoot)

  mkdirSync(dirname(outputPath), { recursive: true })
  if (shouldReuseCompiledWindowsCliLauncher(outputPath, fingerprint)) {
    console.log(`[native-build] reusing Windows CLI launcher at ${outputPath}`)
    process.exit(0)
  }

  rmSync(`${outputPath}.sha256`, { force: true })
  const targetDirectory = join(crateRoot, 'target')
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '--manifest-path',
      manifestPath,
      '--target-dir',
      targetDirectory
    ],
    {
      cwd: crateRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        ORCA_LAUNCHER_VERSION: version,
        ORCA_LAUNCHER_ICON: iconPath
      }
    }
  )

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.error) {
    // Why named explicitly: a bare ENOENT here reads as a missing source file
    // rather than a host without the toolchain the packaged CLI needs.
    throw new Error(
      `Unable to run cargo for the Windows CLI launcher: ${result.error.message}. Install Rust (https://rustup.rs) and retry.`
    )
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  copyFileSync(join(targetDirectory, 'release', 'orca.exe'), outputPath)
  writeFileSync(`${outputPath}.sha256`, fingerprint)
}
