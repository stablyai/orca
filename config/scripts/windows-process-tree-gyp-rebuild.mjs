import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..', '..')
export const WINDOWS_PROCESS_TREE_PACKAGE_DIR = join(
  ROOT,
  'node_modules',
  '@vscode',
  'windows-process-tree'
)
export const WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS = [
  'napi.h',
  'napi-inl.h',
  'napi-inl.deprecated.h'
]
const BINARY = 'windows_process_tree.node'
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

export function stageWindowsProcessTreeNodeAddonApiHeaders(packageDir, buildDir) {
  const headers = dirname(
    createRequire(join(packageDir, 'package.json')).resolve('node-addon-api/package.json')
  )
  const destination = join(buildDir, 'deps', 'node-addon-api')
  mkdirSync(destination, { recursive: true })
  for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
    copyFileSync(join(headers, header), join(destination, header))
  }
  return destination
}

async function prepareSource(packageDir, buildDir) {
  for (const entry of ['package.json', 'binding.gyp', 'src', 'lib']) {
    await cp(join(packageDir, entry), join(buildDir, entry), {
      recursive: true
    })
  }
  await ensureWindowsProcessTreeCommandLinePatch(buildDir)
  // Repair legacy build hunks only in the private copy, never pnpm's hardlinked source.
  const bindingPath = join(buildDir, 'binding.gyp')
  let binding = readFileSync(bindingPath, 'utf8')
  binding = binding.replace(/^\s*".*node_addon_api_except",?\r?\n/gm, '')
  binding = binding.replace(
    '"include_dirs": []',
    '"include_dirs": ["deps/node-addon-api"],\n"defines": ["NAPI_CPP_EXCEPTIONS", "_HAS_EXCEPTIONS=1"]'
  )
  if (!binding.includes('"ExceptionHandling": 1')) {
    binding = binding.replace(
      '"VCCLCompilerTool": {',
      '"VCCLCompilerTool": {\n"ExceptionHandling": 1,'
    )
  }
  binding = binding.replace(
    /\r?\n\s*"msvs_configuration_attributes": \{\s*"SpectreMitigation": "Spectre"\s*\},?/s,
    ''
  )
  writeFileSync(bindingPath, binding)
  const processPath = join(buildDir, 'src', 'process.cc')
  const source = readFileSync(processPath, 'utf8')
    .replace(/process_count < 1024 && /, '')
    .replaceAll(
      'OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)',
      'OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)'
    )
  writeFileSync(processPath, source)
  const header = readFileSync(join(buildDir, 'src', 'process.h'), 'utf8')
  const worker = readFileSync(join(buildDir, 'src', 'process_worker.cc'), 'utf8')
  const api = readFileSync(join(buildDir, 'lib', 'index.js'), 'utf8')
  if (
    binding.includes('SpectreMitigation') ||
    binding.includes('node_addon_api.gyp') ||
    binding.includes("require('node-addon-api')") ||
    !binding.includes('deps/node-addon-api') ||
    !binding.includes('NAPI_CPP_EXCEPTIONS') ||
    source.includes('process_count < 1024') ||
    source.includes('OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ') ||
    !readFileSync(join(buildDir, 'src/addon.cc'), 'utf8').includes('"supportsCreationTime"') ||
    !source.includes('GetProcessTimes(hProcess, &creationTime') ||
    !header.includes('CREATIONTIME = 4') ||
    !worker.includes('object.Set("creationTimeMs"') ||
    !api.includes('ProcessDataFlag["CreationTime"] = 4')
  ) {
    throw new Error(
      'windows-process-tree source is missing required patch hunks; run pnpm install --frozen-lockfile.'
    )
  }
  stageWindowsProcessTreeNodeAddonApiHeaders(packageDir, buildDir)
}

export function assertWindowsProcessTreeArchitecture(binaryPath, arch) {
  const bytes = readFileSync(binaryPath)
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1
  if (
    bytes.toString('ascii', 0, 2) !== 'MZ' ||
    offset < 64 ||
    offset + 6 > bytes.length ||
    bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(offset + 4) !== PE_MACHINE[arch]
  ) {
    throw new Error(`windows-process-tree output is not a ${arch} PE binary: ${binaryPath}`)
  }
}

export async function withWindowsProcessTreeBuild(
  {
    packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR,
    arch = process.arch,
    outFile,
    tempRoot = tmpdir()
  },
  build
) {
  if (!Object.hasOwn(PE_MACHINE, arch)) {
    throw new Error(`Unsupported windows-process-tree architecture: ${arch}`)
  }
  const buildDir = realpathSync(mkdtempSync(join(tempRoot, 'orca-wpt-')))
  try {
    // MSBuild FileTracker still uses MAX_PATH, including its generated .tlog suffixes.
    const longestIntermediate = join(
      buildDir,
      'build',
      'Release',
      'obj',
      'windows_process_tree',
      'windows_process_tree.tlog',
      'windows_process_tree.lastbuildstate'
    )
    if (longestIntermediate.length >= 240) {
      throw new Error(
        `Windows native temporary path exceeds the 239-character build budget: ${
          longestIntermediate
        }`
      )
    }
    await prepareSource(realpathSync(packageDir), buildDir)
    console.log(`[windows-process-tree] building ${arch} in ${buildDir}`)
    await build(buildDir)
    const binaryPath = join(buildDir, 'build', 'Release', BINARY)
    assertPatchedWindowsProcessTreeBinary(binaryPath, arch)
    const destination = outFile ?? join(packageDir, 'build', 'Release', BINARY)
    mkdirSync(dirname(destination), { recursive: true })
    const publishDir = mkdtempSync(join(dirname(destination), '.wpt-'))
    try {
      const pending = join(publishDir, BINARY)
      copyFileSync(binaryPath, pending)
      // Rename replaces the directory entry without writing through an existing hardlink.
      renameSync(pending, destination)
    } finally {
      rmSync(publishDir, { recursive: true, force: true })
    }
    return destination
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

let processRunner
async function getProcessRunner() {
  if (processRunner) {
    return processRunner
  }
  const base = new URL('../../src/shared/child-process/', import.meta.url)
  // Build scripts run directly on Node 24; source modules use extensionless TS imports.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.startsWith(base.href) &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.ts')
      ) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    }
  })
  try {
    processRunner = (await import(new URL('run-process.ts', base).href)).runProcess
    return processRunner
  } finally {
    hook.deregister()
  }
}

export async function runWindowsProcessTreeBuildProcess(program, args, options = {}) {
  const runProcess = await getProcessRunner()
  const result = await runProcess({
    program,
    args,
    timeoutMs: 600_000,
    stdio: 'inherit',
    ...options
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `windows-process-tree command failed (exit=${result.code}, timeout=${result.timedOut}): ${
        program
      }\n${result.stderr}`
    )
  }
}

export async function probeWindowsProcessTreeBuild(
  buildDir,
  executable = process.execPath,
  electron = false
) {
  assertPatchedWindowsProcessTreeBinary(windowsProcessTreeAddonPath(buildDir), process.arch)
  await runWindowsProcessTreeBuildProcess(
    executable,
    [join(ROOT, 'config', 'scripts', 'windows-process-tree-capability.cjs'), buildDir],
    {
      timeoutMs: 10_000,
      env: {
        ...process.env,
        ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    }
  )
}

export async function rebuildWindowsProcessTreeForNode(options = {}) {
  const { arch = process.arch, projectDir = ROOT } = options
  const nodeGyp = createRequire(join(projectDir, 'package.json')).resolve(
    'node-gyp/bin/node-gyp.js'
  )
  return withWindowsProcessTreeBuild({ ...options, arch }, async (buildDir) => {
    await runWindowsProcessTreeBuildProcess(
      process.execPath,
      [nodeGyp, 'rebuild', `--arch=${arch}`],
      { cwd: buildDir }
    )
    if (arch === process.arch) {
      await probeWindowsProcessTreeBuild(buildDir)
    }
  })
}
export function windowsProcessTreeAddonPath(packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR) {
  return join(packageDir, 'build', 'Release', BINARY)
}

export function inspectWindowsProcessTreeAddon(addonPath) {
  if (!existsSync(addonPath)) {
    return 'missing'
  }
  return readFileSync(addonPath).includes('ReadProcessMemory') ? 'unpatched' : 'clean'
}

function assertPatchedWindowsProcessTreeBinary(addonPath, arch) {
  const state = inspectWindowsProcessTreeAddon(addonPath)
  if (state !== 'clean') {
    throw new Error(
      state === 'missing'
        ? `The rebuild reported success but ${addonPath} is not there.`
        : `${addonPath} still imports ReadProcessMemory; refusing an unpatched command-line reader.`
    )
  }
  assertWindowsProcessTreeArchitecture(addonPath, arch)
}

// Called only on the private build copy; preserve installed source and output on failure.
export async function ensureWindowsProcessTreeCommandLinePatch(buildDir) {
  const source = join(buildDir, 'src', 'process_commandline.cc')
  if (!existsSync(source)) {
    throw new Error(`${source} is missing; run pnpm install.`)
  }
  if (readFileSync(source, 'utf8').includes('kProcessCommandLineInformation')) {
    return false
  }
  try {
    await runWindowsProcessTreeBuildProcess(
      'git',
      [
        '-c',
        'core.autocrlf=input',
        'apply',
        '--include=src/process_commandline.cc',
        join(ROOT, 'config/patches/@vscode__windows-process-tree@0.8.0.patch')
      ],
      { cwd: buildDir, env: { ...process.env, GIT_DIR: join(buildDir, '.orca-no-such-git-dir') } }
    )
  } catch (error) {
    throw new Error(
      `src/process_commandline.cc still reads the PEB, and repairing it failed: ${error.message}`
    )
  }
  if (!readFileSync(source, 'utf8').includes('kProcessCommandLineInformation')) {
    throw new Error(
      'src/process_commandline.cc still reads the PEB after repair; run pnpm install.'
    )
  }
  return true
}
