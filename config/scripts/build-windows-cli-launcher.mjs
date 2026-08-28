#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function shouldReuseCompiledWindowsCliLauncher(
  outputPath,
  sourcePath,
  { reuseCached = false } = {}
) {
  if (!existsSync(outputPath)) {
    return false
  }
  // Why reuseCached: Actions cache keys already hash the C# source, but restore
  // does not preserve mtimes, so a hit would look stale and recompile anyway.
  if (reuseCached) {
    return true
  }
  return statSync(outputPath).mtimeMs >= statSync(sourcePath).mtimeMs
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
  const outputPath = readArg('--output') ?? defaultOutputPath(repoRoot)
  const compilerPath = findFrameworkCompiler(process.env)

  if (!compilerPath) {
    throw new Error('Unable to find the .NET Framework C# compiler required for orca.exe.')
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  if (
    shouldReuseCompiledWindowsCliLauncher(outputPath, sourcePath, {
      reuseCached: process.env.ORCA_REUSE_WINDOWS_CLI_LAUNCHER === '1'
    })
  ) {
    console.log(`[native-build] reusing Windows CLI launcher at ${outputPath}`)
    process.exit(0)
  }
  const result = spawnSync(
    compilerPath,
    ['/nologo', '/target:exe', '/optimize+', '/warnaserror+', `/out:${outputPath}`, sourcePath],
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
}
