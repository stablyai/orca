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
// Why: --source compiles an arbitrary file instead of a named target, so tests can build a
// throwaway stub without --target silently rebuilding the launcher against the stub's name.
const explicitSource = readArg('--source')
const explicitOutput = readArg('--output')
// Why: without --output a stub would compile straight over the real orca.exe/tmux.exe.
if (explicitSource && !explicitOutput) {
  throw new Error('--source requires --output to avoid overwriting the target build output.')
}
const outputPath = explicitOutput ?? defaultOutputPath(repoRoot, target)
const sourceFiles = explicitSource
  ? [resolve(explicitSource)]
  : sourceFilesForTarget(target, repoRoot)
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

/** Where a named target's executable is written when --output is omitted. */
function defaultOutputPath(projectRoot, target) {
  return join(projectRoot, 'native', 'windows-cli-launcher', '.build', `${target}.exe`)
}

/** The C# sources compiled for a named target. */
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

/** Locates the .NET Framework csc.exe, which ships with Windows and needs no SDK install. */
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

/** Reads `--name value` from argv, or undefined when absent. */
function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}
