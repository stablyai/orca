#!/usr/bin/env node
// Compile N-API privacy addon for pinned-Node orcad; missing addon fails startup closed.
// Build a private copy to preserve desktop host addon; Windows x64 cross-compiles arm64. Usage: --arch=arm64.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { NODE_RUNTIME_ASSETS } from '../../src/shared/node-runtime-pin.ts'
import { sha256Of } from './orcad-prebuild-slot-contents.mjs'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from '../../src/shared/orcad-artifacts.ts'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

const ROOT = resolve(import.meta.dirname, '..', '..')
const SUPPORTED_ARCHES = ['x64', 'arm64']

export function windowsSecurityAddonOutput(root, arch) {
  return join(root, '.build', 'windows-security', arch, ORCAD_WINDOWS_SECURITY_FILENAME)
}

export function probeWindowsSecurityAddon(
  runtimePath,
  candidate,
  arch,
  run = runProcessSync,
  cwd = ROOT
) {
  return run({
    program: runtimePath,
    args: [
      '-e',
      `if (process.platform !== 'win32' || process.arch !== ${JSON.stringify(arch)} || process.versions.electron) process.exit(1);` +
        `const sid = require(${JSON.stringify(candidate)}).currentUserSid();` +
        `if (typeof sid !== 'string' || !/^S-1-\\d+(?:-\\d+)+$/.test(sid)) process.exit(2);` +
        `process.stdout.write('windows-security-ready');`
    ],
    cwd,
    timeoutMs: 30_000
  })
}

export function reusePreparedWindowsSecurityAddon(
  arch,
  output,
  {
    enabled = false,
    runtimePath,
    root = ROOT,
    platform = process.platform,
    hostArch = process.arch,
    runtimeAssets = NODE_RUNTIME_ASSETS,
    run = runProcessSync
  } = {}
) {
  if (!enabled || platform !== 'win32' || arch !== hostArch || !runtimePath) {
    return false
  }
  const candidate = resolve(
    root,
    'native/windows-security/build/Release/orca_windows_security.node'
  )
  try {
    if (
      readPeMachine(candidate) !== PE_MACHINE[arch] ||
      !isAbsolute(runtimePath) ||
      sha256Of(runtimePath) !== runtimeAssets[`win32-${arch}`]?.executableSha256
    ) {
      return false
    }
    const prepared = run({
      program: process.execPath,
      args: [
        join(root, 'config/scripts/ensure-native-runtime.mjs'),
        '--runtime=node',
        '--check-only'
      ],
      cwd: root,
      timeoutMs: 30_000
    })
    if (prepared.code !== 0 || prepared.timedOut || prepared.outputTruncated) {
      return false
    }
    const probe = probeWindowsSecurityAddon(runtimePath, candidate, arch, run, root)
    if (
      probe.code !== 0 ||
      probe.timedOut ||
      probe.outputTruncated ||
      probe.stdout !== 'windows-security-ready'
    ) {
      return false
    }
  } catch {
    return false
  }
  mkdirSync(resolve(output, '..'), { recursive: true })
  copyFileSync(candidate, output)
  console.log(`[windows-security] reused prepared ${arch} -> ${output}`)
  return true
}

export function buildWindowsSecurityAddon(
  arch,
  output = windowsSecurityAddonOutput(ROOT, arch),
  { root = ROOT, run = runProcessSync, ...options } = {}
) {
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`--arch must be one of ${SUPPORTED_ARCHES.join(', ')}; got ${arch}`)
  }
  if (process.platform !== 'win32') {
    throw new Error(
      `The Windows security addon only builds on Windows; running on ${process.platform}.`
    )
  }
  if (reusePreparedWindowsSecurityAddon(arch, output, { ...options, root, run })) {
    return output
  }
  // Inside the repo so binding.gyp's `require('node-addon-api')` resolves from root node_modules.
  const workDir = join(root, '.build', 'windows-security', arch, 'gyp')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  copyFileSync(join(root, 'native/windows-security/binding.gyp'), join(workDir, 'binding.gyp'))
  cpSync(join(root, 'native/windows-security/src'), join(workDir, 'src'), { recursive: true })
  const result = run({
    program: process.execPath,
    args: [
      join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      'rebuild',
      `--arch=${arch}`
    ],
    cwd: workDir,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`node-gyp failed for ${arch} with exit ${result.code}`)
  }
  const built = join(workDir, 'build', 'Release', 'orca_windows_security.node')
  if (!existsSync(built)) {
    throw new Error(`node-gyp reported success but ${built} is missing.`)
  }
  // Why check the artifact: node-gyp can ignore --arch, and a host could not load the result.
  const machine = readPeMachine(built)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Built binary is ${describePeMachine(machine)}, expected ${arch}.`)
  }
  mkdirSync(resolve(output, '..'), { recursive: true })
  copyFileSync(built, output)
  console.log(`[windows-security] ${arch} -> ${output}`)
  return output
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const arch =
      process.argv.find((arg) => arg.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch
    buildWindowsSecurityAddon(arch, undefined, {
      enabled: process.argv.includes('--reuse-prepared-runtime'),
      runtimePath: process.argv
        .find((arg) => arg.startsWith('--node-runtime='))
        ?.slice('--node-runtime='.length)
    })
  } catch (error) {
    console.error(`[windows-security] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
