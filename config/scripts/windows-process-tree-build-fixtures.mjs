import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function copyWindowsProcessTreeBuildScripts(projectDir) {
  const scripts = join(projectDir, 'config', 'scripts')
  mkdirSync(scripts, { recursive: true })
  for (const name of [
    'windows-process-tree-gyp-rebuild.mjs',
    'windows-process-tree-capability.cjs'
  ]) {
    copyFileSync(join(import.meta.dirname, name), join(scripts, name))
  }
  cpSync(
    resolve(import.meta.dirname, '../../src/shared/child-process'),
    join(projectDir, 'src/shared/child-process'),
    {
      recursive: true,
      filter: (source) => !source.includes('__fixtures__') && !source.endsWith('.test.ts')
    }
  )
}

export const LOADABLE_PROCESS_TREE =
  'exports.ProcessDataFlag = { CreationTime: 4 }; exports.getProcessList = (pid, callback) => callback([{ pid, creationTimeMs: 123 }]);\n'

export function writeWindowsProcessTreeSource(packageDir) {
  for (const dir of ['src', 'lib', 'node_modules/node-addon-api']) {
    mkdirSync(join(packageDir, dir), { recursive: true })
  }
  writeFileSync(
    join(packageDir, 'package.json'),
    '{"name":"@vscode/windows-process-tree","version":"0.8.0","main":"lib/index.js","dependencies":{"node-addon-api":"7.1.0"}}'
  )
  writeFileSync(
    join(packageDir, 'binding.gyp'),
    '{"include_dirs": ["deps/node-addon-api"], "defines": ["NAPI_CPP_EXCEPTIONS"], "VCCLCompilerTool": {"ExceptionHandling": 1}}'
  )
  writeFileSync(join(packageDir, 'src/process.cc'), 'GetProcessTimes(hProcess, &creationTime')
  writeFileSync(join(packageDir, 'src/process_commandline.cc'), '// kProcessCommandLineInformation')
  writeFileSync(join(packageDir, 'src/addon.cc'), '// "supportsCreationTime"')
  writeFileSync(join(packageDir, 'src/process.h'), 'CREATIONTIME = 4')
  writeFileSync(join(packageDir, 'src/process_worker.cc'), 'object.Set("creationTimeMs"')
  writeFileSync(
    join(packageDir, 'lib/index.js'),
    `// ProcessDataFlag["CreationTime"] = 4\n${LOADABLE_PROCESS_TREE}`
  )
  const headers = join(packageDir, 'node_modules/node-addon-api')
  writeFileSync(join(headers, 'package.json'), '{"name":"node-addon-api"}')
  for (const name of ['napi.h', 'napi-inl.h', 'napi-inl.deprecated.h']) {
    writeFileSync(join(headers, name), `// ${name}\n`)
  }
}

export function writeWindowsProcessTreeBinary(packageDir, arch = 'x64') {
  const file = join(packageDir, 'build/Release/windows_process_tree.node')
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return file
}
