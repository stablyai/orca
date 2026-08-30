#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows ReFS block-clone helper compilation requires a Windows host.')
}

const repoRoot = resolve(import.meta.dirname, '../..')
const sourceRoot = join(repoRoot, 'native', 'windows-block-clone')
const sourcePath = join(sourceRoot, 'OrcaBlockClone.cpp')
const manifestPath = join(sourceRoot, 'app.manifest')
const outputPath = readArg('--output') ?? join(sourceRoot, '.build', 'orca-block-clone.exe')
const architecture = readArg('--arch') ?? process.arch

if (!['x64', 'arm64'].includes(architecture)) {
  throw new Error(`Unsupported Windows block-clone architecture: ${architecture}`)
}

mkdirSync(dirname(outputPath), { recursive: true })
const buildRoot = mkdtempSync(join(tmpdir(), 'orca block clone build '))
try {
  const compilerEnvironment = loadMsvcEnvironment(process.env, architecture)
  const result = spawnSync(
    'cl.exe',
    [
      '/nologo',
      '/std:c++20',
      '/O2',
      '/W4',
      '/WX',
      '/EHsc',
      '/MT',
      '/utf-8',
      '/permissive-',
      '/Zc:__cplusplus',
      `/Fo:${join(buildRoot, 'OrcaBlockClone.obj')}`,
      `/Fe:${outputPath}`,
      sourcePath,
      '/link',
      '/MANIFEST:EMBED',
      `/MANIFESTINPUT:${manifestPath}`
    ],
    { cwd: repoRoot, env: compilerEnvironment, stdio: 'inherit' }
  )

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  }
} finally {
  rmSync(buildRoot, { recursive: true, force: true })
}

function loadMsvcEnvironment(env, architecture) {
  const installationPath = findVisualStudioInstallation(env, architecture)
  const setupPath = join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat')
  if (!existsSync(setupPath)) {
    throw new Error(`Visual Studio developer command file is unavailable: ${setupPath}`)
  }
  const command = `call "${setupPath}" -no_logo -arch=${architecture} -host_arch=x64 >nul && set`
  const result = spawnSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    encoding: 'utf8',
    env,
    windowsVerbatimArguments: true
  })
  if (result.status !== 0 || result.error) {
    throw result.error ?? new Error(result.stderr.trim() || 'Unable to initialize MSVC')
  }
  const configured = { ...env }
  for (const line of result.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      configured[line.slice(0, separator)] = line.slice(separator + 1)
    }
  }
  return configured
}

function findVisualStudioInstallation(env, architecture) {
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) {
    throw new Error('Visual Studio Build Tools are required to compile the block-clone helper.')
  }
  const result = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      architecture === 'arm64'
        ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
        : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath'
    ],
    { encoding: 'utf8', env }
  )
  const installationPath = result.stdout?.trim() ?? ''
  if (result.status !== 0 || result.error || !installationPath) {
    throw result.error ?? new Error('Visual Studio C++ Build Tools are unavailable.')
  }
  return installationPath
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}
