#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows ReFS block-clone helper compilation requires a Windows host.')
}

const repoRoot = resolve(import.meta.dirname, '../..')
const sourceRoot = join(repoRoot, 'native', 'windows-block-clone')
const sourcePath = join(sourceRoot, 'OrcaBlockClone.cs')
const manifestPath = join(sourceRoot, 'app.manifest')
const outputPath = readArg('--output') ?? join(sourceRoot, '.build', 'orca-block-clone.exe')
const compilerPath = findFrameworkCompiler(process.env)

if (!compilerPath) {
  throw new Error('Unable to find the .NET Framework C# compiler required for block cloning.')
}

mkdirSync(dirname(outputPath), { recursive: true })
const result = spawnSync(
  compilerPath,
  [
    '/nologo',
    '/target:exe',
    '/optimize+',
    '/warnaserror+',
    `/win32manifest:${manifestPath}`,
    `/out:${outputPath}`,
    sourcePath
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
  return index !== -1 ? process.argv[index + 1] : undefined
}
