#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  // Why: electron-builder treats a skipped native build like success and can
  // continue toward a Windows package whose declared orca.exe does not exist.
  throw new Error(
    'Windows CLI launcher compilation requires a Windows host; refusing to package without it.'
  )
}

const repoRoot = resolve(import.meta.dirname, '../..')
const target = readArg('--target') ?? 'orca'
const outputPath = readArg('--output') ?? defaultOutputPath(repoRoot, target)
const sourceFiles = sourceFilesForTarget(target, repoRoot)
const compilerPath = findFrameworkCompiler(process.env)

if (!compilerPath) {
  throw new Error('Unable to find the .NET Framework C# compiler required for orca.exe.')
}

mkdirSync(dirname(outputPath), { recursive: true })
const result = spawnSync(
  compilerPath,
  ['/nologo', '/target:exe', '/optimize+', '/warnaserror+', `/out:${outputPath}`, ...sourceFiles],
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

function defaultOutputPath(projectRoot, target) {
  return join(projectRoot, 'native', 'windows-cli-launcher', '.build', `${target}.exe`)
}

function sourceFilesForTarget(target, projectRoot) {
  const base = join(projectRoot, 'native', 'windows-cli-launcher')
  switch (target) {
    case 'orca':
      return [join(base, 'OrcaCliLauncher.cs'), join(base, 'WindowsCommandLine.cs')]
    case 'tmux':
      return [join(base, 'OrcaTmuxShim.cs'), join(base, 'WindowsCommandLine.cs')]
    default:
      throw new Error(`Unknown target: ${target}. Expected 'orca' or 'tmux'.`)
  }
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
  return index >= 0 ? process.argv[index + 1] : undefined
}
