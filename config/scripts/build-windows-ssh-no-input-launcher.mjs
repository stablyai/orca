#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows SSH no-input launcher compilation requires a Windows host.')
}

const repoRoot = resolve(import.meta.dirname, '../..')
const sourceRoot = join(repoRoot, 'native', 'windows-ssh-no-input-launcher')
const sourcePaths = [
  'OrcaSshNoInputLauncher.cs',
  'WindowsCommandLine.cs',
  'WindowsPrivateConsoleInput.cs',
  'WindowsBoundedOutputFiles.cs',
  'WindowsSshChildProcess.cs'
].map((name) => join(sourceRoot, name))
const outputPath = readArg('--output') ?? join(sourceRoot, '.build', 'orca-ssh-no-input.exe')
const compilerPath = findFrameworkCompiler(process.env)

if (!compilerPath) {
  throw new Error('Unable to find the .NET Framework C# compiler for the SSH no-input launcher.')
}
for (const sourcePath of sourcePaths) {
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing Windows SSH no-input launcher source: ${sourcePath}`)
  }
}

mkdirSync(dirname(outputPath), { recursive: true })
const result = spawnSync(
  compilerPath,
  [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/warnaserror+',
    `/out:${outputPath}`,
    ...sourcePaths
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
  if (index < 0) {
    return undefined
  }
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a path.`)
  }
  return resolve(value)
}
