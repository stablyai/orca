#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows playback suppression compilation requires a Windows host.')
}

const repoRoot = resolve(import.meta.dirname, '../..')
const sourcePath = join(
  repoRoot,
  'native',
  'playback-suppression-windows',
  'OrcaPlaybackSuppression.cs'
)
const outputPath =
  readArg('--output') ??
  join(
    repoRoot,
    'native',
    'playback-suppression-windows',
    '.build',
    'orca-playback-suppression.exe'
  )
const compilerPath = findFrameworkCompiler(process.env)
if (!compilerPath) {
  throw new Error(
    'Unable to find the .NET Framework C# compiler required for playback suppression.'
  )
}

mkdirSync(dirname(outputPath), { recursive: true })
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
verifySnapshotContract(runSelfTest(outputPath))

function runSelfTest(helperPath) {
  const selfTest = spawnSync(helperPath, ['self-test'], { encoding: 'utf8' })
  if (selfTest.signal) {
    process.kill(process.pid, selfTest.signal)
  }
  if (selfTest.error) {
    throw selfTest.error
  }
  if (selfTest.status !== 0) {
    throw new Error(selfTest.stderr || 'Windows playback suppression helper self-test failed.')
  }
  return selfTest.stdout
}

function verifySnapshotContract(stdout) {
  const snapshot = JSON.parse(stdout)
  if (
    snapshot.endpointId !== 'orca-test-endpoint' ||
    snapshot.endpointTarget !== 'orca-test-endpoint' ||
    snapshot.muted !== false
  ) {
    throw new Error('Windows playback suppression helper returned an invalid self-test snapshot.')
  }
}

function findFrameworkCompiler(env) {
  const windowsDirectory = env.WINDIR ?? env.SystemRoot
  if (!windowsDirectory) {
    return null
  }
  return (
    [
      join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
    ].find((candidate) => existsSync(candidate)) ?? null
  )
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
