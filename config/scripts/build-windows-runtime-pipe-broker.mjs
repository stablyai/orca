#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows runtime pipe broker compilation requires a Windows host.')
}

const root = resolve(import.meta.dirname, '../..')
const source = join(root, 'native', 'windows-runtime-pipe-broker', 'OrcaRuntimePipeBroker.cs')
const output = join(root, 'native', 'windows-runtime-pipe-broker', '.build', 'orca-pipe-broker.exe')
const windowsDirectory = process.env.WINDIR ?? process.env.SystemRoot
const compiler = windowsDirectory
  ? [
      join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
    ].find(existsSync)
  : undefined

if (!compiler) throw new Error('Unable to find the .NET Framework C# compiler for pipe broker.')
mkdirSync(dirname(output), { recursive: true })
const result = spawnSync(
  compiler,
  ['/nologo', '/target:exe', '/optimize+', '/warnaserror+', `/out:${output}`, source],
  { cwd: root, stdio: 'inherit' }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
