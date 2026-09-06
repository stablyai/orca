#!/usr/bin/env node
/**
 * Compile `@vscode/windows-process-tree` for a relay host.
 *
 * The relay is deployed to machines with no compiler, and this addon cannot be
 * npm-installed there: it carries a binding.gyp, so npm rebuilds from source and
 * the build wants Spectre-mitigated libraries even where MSVC is present. The
 * binary inside the published tarball loads, but predates our patch and still
 * caps enumeration at 1024 processes -- a busy host then gets a truncated table
 * missing its own pid, which reads as "unavailable" only under load.
 *
 * So we compile it here, from the patched source pnpm already materialized, and
 * ship the result as a relay artifact. Windows arm64 cross-compiles from an x64
 * runner, so both arches come off one Windows job.
 *
 * Node headers, not Electron: the relay runs under the host's own `node`. The
 * addon is N-API, so one build serves every Node the remote might have.
 *
 *   node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=arm64
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'
import {
  ensureWindowsProcessTreeCommandLinePatch,
  inspectWindowsProcessTreeAddon,
  nodeGypRebuildInvocation,
  stageWindowsProcessTreeNodeAddonApiHeaders,
  WINDOWS_PROCESS_TREE_PACKAGE_DIR as PACKAGE_DIR
} from './windows-process-tree-gyp-rebuild.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const SUPPORTED_ARCHES = ['x64', 'arm64']

/** PE `IMAGE_FILE_HEADER.Machine` values, so a cross-build cannot silently emit host arch. */
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

function parseArgs(argv) {
  const arch = argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch
  const outDir = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`--arch must be one of ${SUPPORTED_ARCHES.join(', ')}; got ${arch}`)
  }
  return {
    arch,
    outDir: outDir ? resolve(outDir) : join(ROOT, '.build', 'windows-process-tree', arch)
  }
}

/**
 * Refuse to build unpatched source.
 *
 * Each hunk fails differently: Spectre dies outright, the 1024-process cap
 * succeeds and lies, and `.targets` is cwd-relative so pnpm's nested layout
 * makes node-gyp miss node_addon_api.gyp on Windows. Checking the source
 * rather than trusting the install is what stops a silently unpatched tree
 * from being shipped as if it were patched.
 */
function assertPatchApplied() {
  const bindingGyp = readFileSync(join(PACKAGE_DIR, 'binding.gyp'), 'utf8')
  if (bindingGyp.includes('SpectreMitigation')) {
    throw new Error(
      'binding.gyp still requests SpectreMitigation. pnpm did not apply ' +
        'config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  if (bindingGyp.includes('node_addon_api.gyp')) {
    throw new Error(
      'binding.gyp still depends on node_addon_api.gyp. pnpm and node-gyp rewrite that ' +
        'project path incorrectly on Windows. ' +
        'pnpm did not apply config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  if (!bindingGyp.includes('"include_dirs": ["deps/node-addon-api"]')) {
    throw new Error('binding.gyp does not use the staged node-addon-api headers.')
  }
  const processCc = readFileSync(join(PACKAGE_DIR, 'src', 'process.cc'), 'utf8')
  if (processCc.includes('process_count < 1024')) {
    throw new Error(
      'src/process.cc still caps enumeration at 1024 processes. pnpm did not apply ' +
        'config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  if (processCc.includes('OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ')) {
    throw new Error(
      'src/process.cc still takes PROCESS_VM_READ for memory or CPU counters it never reads ' +
        'from the address space. pnpm did not apply ' +
        'config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  // Every string the repair below can write, so a repaired tree cannot be
  // declared patched while one of the pieces is silently missing.
  const requiredCreationTimeSources = [
    ['src/process.h', 'CREATIONTIME = 4'],
    ['src/process.h', 'ULONGLONG creationTimeMs'],
    ['src/process.cc', 'GetProcessCreationTime(pinfo)'],
    ['src/process.cc', 'GetProcessTimes(hProcess, &creationTime'],
    ['src/process_worker.cc', 'object.Set("creationTimeMs"'],
    ['src/addon.cc', 'exports.Set("supportedProcessDataFlags"'],
    ['lib/index.js', '["CreationTime"] = 4'],
    ['lib/index.js', 'exports.supportedProcessDataFlags'],
    ['lib/index.js', 'creationTimeMs,'],
    ['lib/index.ts', 'CreationTime = 4'],
    ['lib/index.ts', 'export const supportedProcessDataFlags'],
    ['lib/index.ts', 'creationTimeMs,'],
    ['typings/windows-process-tree.d.ts', 'creationTimeMs?: number'],
    // A regex because IProcessInfo declares the same field: only the tree node
    // is followed by `children`, and that is the one buildNode fills.
    ['typings/windows-process-tree.d.ts', /creationTimeMs\?: number;\r?\n\s*children:/],
    ['typings/windows-process-tree.d.ts', 'export const supportedProcessDataFlags']
  ]
  for (const [relativePath, expected] of requiredCreationTimeSources) {
    const source = readFileSync(join(PACKAGE_DIR, relativePath), 'utf8')
    const present = typeof expected === 'string' ? source.includes(expected) : expected.test(source)
    if (!present) {
      throw new Error(
        `${relativePath} does not contain the process creation-time patch (${expected}). ` +
          'Run pnpm install before building the relay addon.'
      )
    }
  }
}

function repairCreationTimeSources() {
  let repaired = false
  const rewrite = (relativePath, transform) => {
    const filePath = join(PACKAGE_DIR, relativePath)
    const source = readFileSync(filePath, 'utf8')
    const next = transform(source, source.includes('\r\n') ? '\r\n' : '\n')
    if (next !== source) {
      writeFileSync(filePath, next)
      repaired = true
    }
  }

  rewrite('src/process.h', (source, eol) => {
    let next = source
    if (!next.includes('ULONGLONG creationTimeMs')) {
      next = next.replace(
        /  std::string commandLine;\r?\n/,
        `  std::string commandLine;${eol}  ULONGLONG creationTimeMs;${eol}`
      )
    }
    if (!next.includes('CREATIONTIME = 4')) {
      next = next.replace(
        /  COMMANDLINE = 2\r?\n/,
        `  COMMANDLINE = 2,${eol}  CREATIONTIME = 4${eol}`
      )
    }
    if (!next.includes('void GetProcessCreationTime')) {
      next = next.replace(
        /void GetProcessMemoryUsage\(ProcessInfo& process_info\);\r?\n/,
        `void GetProcessMemoryUsage(ProcessInfo& process_info);${eol}${eol}` +
          `void GetProcessCreationTime(ProcessInfo& process_info);${eol}`
      )
    }
    return next
  })

  rewrite('src/process.cc', (source, eol) => {
    let next = source.replace('ProcessInfo pinfo;', 'ProcessInfo pinfo{};')
    if (!next.includes('GetProcessCreationTime(pinfo)')) {
      next = next.replace(
        /(        if \(COMMANDLINE & process_data_flags\) \{\r?\n          GetProcessCommandLine\(pinfo\);\r?\n        \})/,
        `$1${eol}${eol}        if (CREATIONTIME & process_data_flags) {${eol}` +
          `          GetProcessCreationTime(pinfo);${eol}        }`
      )
    }
    if (!next.includes('void GetProcessCreationTime(ProcessInfo& process_info) {')) {
      const producer = [
        'void GetProcessCreationTime(ProcessInfo& process_info) {',
        '  HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_info.pid);',
        '  if (hProcess == NULL) {',
        '    return;',
        '  }',
        '',
        '  FILETIME creationTime, exitTime, kernelTime, userTime;',
        '  if (GetProcessTimes(hProcess, &creationTime, &exitTime, &kernelTime, &userTime)) {',
        '    ULARGE_INTEGER timestamp;',
        '    timestamp.LowPart = creationTime.dwLowDateTime;',
        '    timestamp.HighPart = creationTime.dwHighDateTime;',
        '    constexpr ULONGLONG WINDOWS_EPOCH_OFFSET_100NS = 116444736000000000ULL;',
        '    constexpr ULONGLONG HUNDRED_NS_PER_MILLISECOND = 10000ULL;',
        '    if (timestamp.QuadPart >= WINDOWS_EPOCH_OFFSET_100NS) {',
        '      process_info.creationTimeMs =',
        '          (timestamp.QuadPart - WINDOWS_EPOCH_OFFSET_100NS) / HUNDRED_NS_PER_MILLISECOND;',
        '    }',
        '  }',
        '',
        '  CloseHandle(hProcess);',
        '}',
        ''
      ].join(eol)
      next = next.replace(
        'void GetProcessMemoryUsage',
        `${producer}${eol}void GetProcessMemoryUsage`
      )
    }
    return next
  })

  rewrite('src/process_worker.cc', (source, eol) => {
    if (source.includes('object.Set("creationTimeMs"')) {
      return source
    }
    const emission = [
      '    if ((CREATIONTIME & process_data_flags_) && pinfo.creationTimeMs != 0) {',
      '      object.Set("creationTimeMs",',
      '                 Napi::Number::New(env, static_cast<double>(pinfo.creationTimeMs)));',
      '    }',
      ''
    ].join(eol)
    return source.replace(
      '    result.Set(i, object);',
      `${emission}${eol}    result.Set(i, object);`
    )
  })

  rewrite('src/addon.cc', (source, eol) => {
    if (source.includes('exports.Set("supportedProcessDataFlags"')) {
      return source
    }
    return source.replace(
      /(  exports\.Set\("getProcessCpuUsage", Napi::Function::New\(env, GetProcessCpuUsage\)\);\r?\n)/,
      `$1  exports.Set("supportedProcessDataFlags",${eol}` +
        `              Napi::Number::New(env, MEMORY | COMMANDLINE | CREATIONTIME));${eol}`
    )
  })

  // Each piece is guarded on its own: an early-out on the enum alone would let a
  // tree with the enum but no buildNode splat pass as repaired.
  const NATIVE_CONST =
    "const native = process.platform === 'win32' ? require('../build/Release/windows_process_tree.node') : undefined;"
  for (const relativePath of ['lib/index.ts', 'lib/index.js']) {
    const isTs = relativePath.endsWith('.ts')
    rewrite(relativePath, (source, eol) => {
      let next = source
      if (!next.includes('CreationTime')) {
        next = isTs
          ? next.replace('  CommandLine = 2', `  CommandLine = 2,${eol}  CreationTime = 4`)
          : next.replace(
              '    ProcessDataFlag[ProcessDataFlag["CommandLine"] = 2] = "CommandLine";',
              '    ProcessDataFlag[ProcessDataFlag["CommandLine"] = 2] = "CommandLine";' +
                `${eol}    ProcessDataFlag[ProcessDataFlag["CreationTime"] = 4] = "CreationTime";`
            )
      }
      if (!next.includes('supportedProcessDataFlags')) {
        const reExport = isTs
          ? `/** The flag bits this compiled addon reports; undefined off win32. */${eol}` +
            'export const supportedProcessDataFlags: number | undefined = native?.supportedProcessDataFlags;'
          : 'exports.supportedProcessDataFlags = native === undefined ? undefined : native.supportedProcessDataFlags;'
        next = next.replace(NATIVE_CONST, `${NATIVE_CONST}${eol}${reExport}`)
      }
      // buildNode drops any field it does not name, so the destructure and the
      // splat have to move together.
      next = next.replace(/(memory, commandLine)( \}, children \})/, '$1, creationTimeMs$2')
      if (!/\bcreationTimeMs,/.test(next)) {
        next = next.replace(
          /(\r?\n)(\s*)commandLine,(\r?\n\s*children:)/,
          `$1$2commandLine,$1$2creationTimeMs,$3`
        )
      }
      return next
    })
  }

  rewrite('typings/windows-process-tree.d.ts', (source, eol) => {
    let next = source
    if (!next.includes('CreationTime = 4')) {
      next = next.replace('    CommandLine = 2', `    CommandLine = 2,${eol}    CreationTime = 4`)
    }
    if (!next.includes('supportedProcessDataFlags')) {
      next = next.replace(
        /(    CreationTime = 4\r?\n  \}\r?\n)/,
        `$1${eol}  /** The flag bits the compiled addon reports; undefined off win32. */${eol}` +
          `  export const supportedProcessDataFlags: number | undefined;${eol}`
      )
    }
    if (!next.includes('creationTimeMs?: number')) {
      next = next.replace(
        /    commandLine\?: string;\r?\n/,
        `    commandLine?: string;${eol}${eol}` +
          `    /** Process creation time in Unix milliseconds. */${eol}` +
          `    creationTimeMs?: number;${eol}`
      )
    }
    // IProcessTreeNode is the second declaration; only it is followed by children.
    next = next.replace(
      /(    commandLine\?: string;\r?\n)(    children:)/,
      `$1    creationTimeMs?: number;${eol}$2`
    )
    return next
  })
  return repaired
}

// pnpm can materialize this CRLF package without applying its patch. Repair the
// load-bearing build settings before node-gyp so the release build stays safe.
function applyWindowsProcessTreeBuildFixes() {
  const bindingPath = join(PACKAGE_DIR, 'binding.gyp')
  const processPath = join(PACKAGE_DIR, 'src', 'process.cc')
  let bindingGyp = readFileSync(bindingPath, 'utf8')
  let processCc = readFileSync(processPath, 'utf8')
  const originalBinding = bindingGyp
  const originalProcess = processCc

  for (const dynamicDependency of [
    String.raw`<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except`,
    String.raw`<!(node -p \"require.resolve('node-addon-api/node_addon_api.gyp')\"):node_addon_api_except`,
    '../../node-addon-api/node_addon_api.gyp:node_addon_api_except'
  ]) {
    bindingGyp = bindingGyp.replace(`"${dynamicDependency}",`, '')
  }
  bindingGyp = bindingGyp.replace(
    '"include_dirs": []',
    '"include_dirs": ["deps/node-addon-api"],\n          "defines": ["NAPI_CPP_EXCEPTIONS", "_HAS_EXCEPTIONS=1"]'
  )
  if (!bindingGyp.includes('"ExceptionHandling": 1')) {
    bindingGyp = bindingGyp.replace(
      '"VCCLCompilerTool": {',
      '"VCCLCompilerTool": {\n              "ExceptionHandling": 1,'
    )
  }
  bindingGyp = bindingGyp.replace(
    /\r?\n\s*"msvs_configuration_attributes": \{\s*"SpectreMitigation": "Spectre"\s*\},?/s,
    ''
  )
  processCc = processCc.replace(/process_count < 1024 && /, '')
  // The memory and CPU readers only ever call GetProcessMemoryInfo/GetProcessTimes,
  // which need no more than PROCESS_QUERY_LIMITED_INFORMATION; taking VM_READ is
  // what EDR scores.
  processCc = processCc.replaceAll(
    'OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)',
    'OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)'
  )

  if (bindingGyp !== originalBinding) {
    writeFileSync(bindingPath, bindingGyp)
  }
  if (processCc !== originalProcess) {
    writeFileSync(processPath, processCc)
  }
  const repairedCreationTime = repairCreationTimeSources()
  stageWindowsProcessTreeNodeAddonApiHeaders(PACKAGE_DIR)
  const repairedCommandLine = ensureWindowsProcessTreeCommandLinePatch(PACKAGE_DIR)
  if (
    bindingGyp !== originalBinding ||
    processCc !== originalProcess ||
    repairedCommandLine ||
    repairedCreationTime
  ) {
    console.warn('[windows-process-tree] Repaired un-applied pnpm patch hunks before build.')
  }
}

/** Read the PE machine field, so an arm64 request cannot ship an x64 binary. */
function readPeMachine(binaryPath) {
  const fd = openSync(binaryPath, 'r')
  try {
    const header = Buffer.alloc(4)
    readSync(fd, header, 0, 4, 0x3c)
    const peOffset = header.readUInt32LE(0)
    const machine = Buffer.alloc(2)
    readSync(fd, machine, 0, 2, peOffset + 4)
    return machine.readUInt16LE(0)
  } finally {
    closeSync(fd)
  }
}

function main() {
  const { arch, outDir } = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') {
    throw new Error(
      `This addon only builds on Windows; running on ${process.platform}. ` +
        'Relay builds elsewhere simply omit it and fall back to the CIM scan.'
    )
  }
  if (!existsSync(PACKAGE_DIR)) {
    throw new Error(`${PACKAGE_DIR} is missing. Run pnpm install first.`)
  }
  applyWindowsProcessTreeBuildFixes()
  assertPatchApplied()

  const gyp = nodeGypRebuildInvocation(arch)
  console.log(`[windows-process-tree] building ${arch} from ${gyp.cwd}`)
  execFileSync(process.execPath, gyp.args, { cwd: gyp.cwd, stdio: 'inherit' })

  const built = join(PACKAGE_DIR, 'build', 'Release', 'windows_process_tree.node')
  if (!existsSync(built)) {
    throw new Error(`node-gyp reported success but ${built} is missing.`)
  }
  // Why check the artifact and not only the source: the source checks above run
  // before node-gyp, and a stale build directory can outlive them.
  if (inspectWindowsProcessTreeAddon(built) === 'unpatched') {
    throw new Error(
      'The built addon still calls ReadProcessMemory, so it did not come from the patched ' +
        'command-line reader. A relay would get the primitive MDE scores as credential dumping.'
    )
  }
  const machine = readPeMachine(built)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(
      `Built binary is machine 0x${machine.toString(16)}, expected 0x${PE_MACHINE[arch].toString(16)} for ${arch}. ` +
        'node-gyp ignored --arch; a relay would get a binary its host cannot load.'
    )
  }

  mkdirSync(outDir, { recursive: true })
  const staged = join(outDir, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  copyFileSync(built, staged)
  console.log(`[windows-process-tree] ${arch} -> ${staged}`)
}

try {
  main()
} catch (error) {
  console.error(`[windows-process-tree] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
