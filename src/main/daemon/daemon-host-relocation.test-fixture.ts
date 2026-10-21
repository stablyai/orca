import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Build a win-unpacked fixture: exe + blobs + DLLs at root, daemon bundle and
// node-pty under resources, mirroring the packaged layout the copy expects.
export function buildInstallFixture(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'Orca.exe'), 'exe-bytes')
  const processHostDir = join(root, 'resources', 'node_modules', '@orca', 'process-host')
  mkdirSync(join(processHostDir, 'dist'), { recursive: true })
  mkdirSync(join(processHostDir, 'src'), { recursive: true })
  writeFileSync(
    join(processHostDir, 'package.json'),
    JSON.stringify({
      name: '@orca/process-host',
      type: 'commonjs',
      exports: {
        '.': { default: './dist/run-process.js' },
        './spawn-observer': { default: './dist/spawn-observer.js' }
      }
    })
  )
  writeFileSync(
    join(processHostDir, 'dist', 'run-process.js'),
    'module.exports = require("./spawn-observer")'
  )
  writeFileSync(join(processHostDir, 'dist', 'spawn-observer.js'), 'module.exports = {}')
  writeFileSync(join(processHostDir, 'dist', 'run-process.d.ts'), 'export {}')
  writeFileSync(join(processHostDir, 'src', 'run-process.ts'), 'export {}')
  for (const name of ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']) {
    writeFileSync(join(root, name), name)
  }
  writeFileSync(join(root, 'ffmpeg.dll'), 'dll')
  writeFileSync(join(root, 'libEGL.dll'), 'dll')
  const mainDir = join(root, 'resources', 'app.asar.unpacked', 'out', 'main')
  mkdirSync(join(mainDir, 'chunks'), { recursive: true })
  writeFileSync(join(mainDir, 'daemon-entry.js'), 'entry')
  writeFileSync(join(mainDir, 'chunks', 'a.js'), 'chunk')
  writeFileSync(join(root, 'resources', 'app.asar.unpacked', 'out', 'package.json'), '{}')
  const nativeDir = join(root, 'resources', 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(nativeDir, { recursive: true })
  writeFileSync(join(nativeDir, 'conpty.node'), 'native')
  writeFileSync(join(nativeDir, 'conpty.pdb'), 'debug-symbols')
  mkdirSync(join(nativeDir, 'conpty'), { recursive: true })
  writeFileSync(join(nativeDir, 'conpty', 'conpty.dll'), 'conpty-dll')
  // Both win32 prebuilds exist in the packaged tree (build-time prune keeps the
  // `win32-` prefix); the copy filter keeps the host arch's and drops the other.
  const prebuildsRoot = join(root, 'resources', 'node_modules', 'node-pty', 'prebuilds')
  for (const arch of ['win32-x64', 'win32-arm64']) {
    mkdirSync(join(prebuildsRoot, arch), { recursive: true })
    writeFileSync(join(prebuildsRoot, arch, 'pty.node'), `${arch}-prebuild`)
  }
  const processTreeDir = join(root, 'resources', 'node_modules', '@vscode', 'windows-process-tree')
  mkdirSync(join(processTreeDir, 'build', 'Release'), { recursive: true })
  mkdirSync(join(processTreeDir, 'lib'), { recursive: true })
  mkdirSync(join(processTreeDir, 'src'), { recursive: true })
  writeFileSync(join(processTreeDir, 'package.json'), '{"main":"lib/index.js"}')
  writeFileSync(join(processTreeDir, 'lib', 'index.js'), 'module.exports = {}')
  writeFileSync(
    join(processTreeDir, 'build', 'Release', 'windows_process_tree.node'),
    'process-tree-native'
  )
  writeFileSync(join(processTreeDir, 'build', 'Release', 'windows_process_tree.pdb'), 'symbols')
  writeFileSync(join(processTreeDir, 'src', 'process.cc'), 'source')
  writeFileSync(join(processTreeDir, 'lib', 'promises.js'), 'require("./index")')
  mkdirSync(join(processTreeDir, 'build', 'Release', 'obj'), { recursive: true })
  writeFileSync(join(processTreeDir, 'build', 'Release', 'obj', 'addon.obj'), 'intermediate')
}
