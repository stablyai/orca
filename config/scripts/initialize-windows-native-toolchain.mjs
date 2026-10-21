import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'

const ENVIRONMENT_MARKER = 'ORCA_WINDOWS_NATIVE_ENVIRONMENT'
const compilerEnvironmentKey =
  /^(PATH|INCLUDE|LIB|LIBPATH|VCINSTALLDIR|VSINSTALLDIR|VisualStudioVersion|VSCMD_.+|VCTools.+|WindowsSDK.+|UniversalCRT.+|UCRTVersion)$/i

export function parseWindowsCompilerEnvironment(output, arch) {
  const lines = output.split(/\r?\n/)
  const marker = lines.indexOf(ENVIRONMENT_MARKER)
  if (marker === -1) {
    throw new Error('Developer environment receipt is missing')
  }
  const environment = {}
  for (const line of lines.slice(marker + 1)) {
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const name = line.slice(0, separator)
    if (compilerEnvironmentKey.test(name)) {
      environment[name] = line.slice(separator + 1)
    }
  }
  const value = (name) => {
    const key = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase())
    return key ? environment[key] : undefined
  }
  if (!value('VCINSTALLDIR') || !value('VSCMD_VER') || !value('WindowsSDKVersion')) {
    throw new Error('Developer environment lacks the compiler or Windows SDK')
  }
  if (
    !/^\d+\.\d+\./.test(value('VSCMD_VER')) ||
    !/^\d+\.\d+\.\d+\.\d+\\?$/.test(value('WindowsSDKVersion'))
  ) {
    throw new Error('Developer environment has an invalid compiler or Windows SDK version')
  }
  const target = value('VSCMD_ARG_TGT_ARCH')?.toLowerCase()
  if (!(target === arch || (arch === 'x64' && target === 'amd64'))) {
    throw new Error('Developer environment targets a different architecture')
  }
  return environment
}

export function hasWindowsCompilerSelection(environment) {
  return Object.entries(environment).some(
    ([name, value]) =>
      /^(VCINSTALLDIR|GYP_MSVS_VERSION|npm_config_msvs_version|npm_package_config_node_gyp_msvs_version)$/i.test(
        name
      ) && value
  )
}

export function mergeWindowsCompilerEnvironment(environment, compilerEnvironment) {
  const compilerKeys = new Set(Object.keys(compilerEnvironment).map((key) => key.toLowerCase()))
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !compilerKeys.has(key.toLowerCase()))
    ),
    ...compilerEnvironment
  }
}

export function initializeWindowsNativeToolchain() {
  if (process.platform !== 'win32') {
    return
  }
  if (hasWindowsCompilerSelection(process.env)) {
    return
  }
  try {
    if (!['x64', 'arm64'].includes(process.arch)) {
      throw new Error('Windows compiler setup requires a supported runner architecture')
    }
    const programFiles = Object.entries(process.env)
      .filter(([key]) => /^(ProgramFiles|ProgramFiles\(x86\))$/i.test(key))
      .map(([, value]) => value)
    const vswhere = programFiles
      .map((directory) => join(directory, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'))
      .find(existsSync)
    if (!vswhere) {
      throw new Error('Visual Studio discovery tool is unavailable')
    }
    const discovery = runProcessSync({
      program: vswhere,
      args: [
        '-latest',
        '-products',
        '*',
        '-utf8',
        '-requires',
        process.arch === 'arm64'
          ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
          : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath'
      ],
      stdio: 'pipe',
      timeoutMs: 30_000
    })
    const installations = discovery.stdout.trim().split(/\r?\n/).filter(Boolean)
    if (discovery.code !== 0 || installations.length !== 1) {
      throw new Error('Visual Studio discovery did not select one compiler')
    }
    const devcmd = join(installations[0], 'Common7', 'Tools', 'VsDevCmd.bat')
    if (!existsSync(devcmd)) {
      throw new Error('Visual Studio developer command is unavailable')
    }
    // process-host owns the fixed batch runner's quoting and hidden console.
    const result = runProcessSync({
      program: join(import.meta.dirname, 'capture-windows-native-environment.cmd'),
      args: [],
      env: {
        ...process.env,
        ORCA_WINDOWS_VSDEVCMD: devcmd,
        ORCA_WINDOWS_NATIVE_ARCH: process.arch
      },
      stdio: 'pipe',
      timeoutMs: 60_000
    })
    if (result.code !== 0) {
      throw new Error('Visual Studio developer command failed')
    }
    const environment = parseWindowsCompilerEnvironment(result.stdout, process.arch)
    console.log(`[native-runtime] Initialized Windows ${process.arch} compiler environment`)
    return environment
  } catch {
    console.warn(
      '[native-runtime] Compiler environment setup unavailable; retaining node-gyp discovery'
    )
  }
}

export function prepareWindowsNodeRuntime(runProcess = runProcessSync) {
  const script = join(import.meta.dirname, 'ensure-native-runtime.mjs')
  const check = runProcess({
    program: process.execPath,
    args: [script, '--check-only'],
    stdio: 'pipe',
    timeoutMs: null
  })
  const compilerEnvironment = check.code === 0 ? undefined : initializeWindowsNativeToolchain()
  const result = runProcess({
    program: process.execPath,
    args: [script, '--runtime=node'],
    env: compilerEnvironment
      ? mergeWindowsCompilerEnvironment(process.env, compilerEnvironment)
      : process.env,
    stdio: 'inherit',
    timeoutMs: null
  })
  return result.code ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = prepareWindowsNodeRuntime()
}
