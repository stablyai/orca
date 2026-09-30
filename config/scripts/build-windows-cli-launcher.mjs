#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

export function windowsCliLauncherVersionSource(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match || match.slice(1).some((part) => Number(part) > 65534)) {
    throw new Error(`Invalid Windows CLI launcher version: ${version}`)
  }
  const fileVersion = `${match.slice(1).join('.')}.0`
  return [
    'using System.Reflection;',
    `[assembly: AssemblyVersion("${fileVersion}")]`,
    `[assembly: AssemblyFileVersion("${fileVersion}")]`,
    `[assembly: AssemblyInformationalVersion("${version}")]`,
    ''
  ].join('\n')
}

function defaultOutputPath(projectRoot) {
  return join(projectRoot, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
}

function findFrameworkCompiler(env) {
  const windowsDirectory = env.WINDIR ?? env.SystemRoot
  if (!windowsDirectory) {
    return null
  }
  const candidates = [
    join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
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
  const sourcePath = join(repoRoot, 'native', 'windows-cli-launcher', 'OrcaCliLauncher.cs')
  const manifestPath = join(repoRoot, 'native', 'windows-cli-launcher', 'app.manifest')
  const iconPath = join(repoRoot, 'resources', 'build', 'icon.ico')
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const versionSource = windowsCliLauncherVersionSource(version)
  const fingerprint = windowsCliLauncherFingerprint(
    [
      sourcePath,
      manifestPath,
      iconPath,
      join(repoRoot, 'config/scripts/build-windows-cli-launcher.mjs')
    ],
    version
  )
  const outputPath = readArg('--output') ?? defaultOutputPath(repoRoot)
  const compilerPath = findFrameworkCompiler(process.env)

  if (!compilerPath) {
    throw new Error('Unable to find the .NET Framework C# compiler required for orca.exe.')
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  if (shouldReuseCompiledWindowsCliLauncher(outputPath, fingerprint)) {
    console.log(`[native-build] reusing Windows CLI launcher at ${outputPath}`)
    process.exit(0)
  }
  const versionPath = join(dirname(outputPath), 'OrcaCliLauncher.Version.cs')
  writeFileSync(versionPath, versionSource)
  rmSync(`${outputPath}.sha256`, { force: true })
  const result = spawnSync(
    compilerPath,
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/warnaserror+',
      `/win32manifest:${manifestPath}`,
      `/win32icon:${iconPath}`,
      `/out:${outputPath}`,
      sourcePath,
      versionPath
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  writeFileSync(`${outputPath}.sha256`, fingerprint)
}
