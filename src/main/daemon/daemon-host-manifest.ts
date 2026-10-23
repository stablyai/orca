import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, win32 as winPath } from 'node:path'

/** Preserve signed bytes and basename; path-based NSIS sweeps spare the copy, but taskkill /IM can still kill it. */
export const daemonHostExeName = (execPath: string): string => winPath.basename(execPath)

// Electron reads V8 snapshots and ICU data even in Node mode.
const RUNTIME_DATA_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']

/** Share required runtime files across copying and validation to avoid repeated unusable copies. */
export const WINDOWS_PROCESS_TREE_REQUIRED = [
  'package.json',
  'lib/index.js',
  'build/Release/windows_process_tree.node'
] as const

export type CopyOp = {
  sourcePath: string
  /** Destination path relative to the host root, posix-separated. */
  destRel: string
  kind: 'file' | 'dir'
  /** Missing optional sources are skipped. */
  optional?: boolean
  /** Return false to exclude a directory-copy source path. */
  filter?: (sourcePath: string) => boolean
}

export type DaemonHostSources = {
  appDir: string
  execPath: string
  resourcesPath: string
  entrySourcePath: string
  entryRelPath: string
  /** The addon's package; without it the daemon forks a shell per poll (#16905). */
  windowsProcessTreeDir: string
}

export function daemonHostProcessPackageDir(sources: DaemonHostSources): string {
  return join(sources.resourcesPath, 'node_modules', '@orca', 'process-host')
}

function daemonHostNodePtyDir(sources: DaemonHostSources): string {
  return join(sources.resourcesPath, 'node_modules', 'node-pty')
}

/** Plain-path conpty.dll loading can fail past 250 characters even with Windows long paths enabled. */
export const DAEMON_HOST_NATIVE_PATH_BUDGET = 250

export function deepestDaemonHostNativePathLength(
  sources: DaemonHostSources,
  hostRoot: string
): number {
  const nodePtyRel = toPosixRelative(sources.appDir, daemonHostNodePtyDir(sources))
  // OpenConsole.exe sits beside conpty.dll and is longer, so it bounds both.
  return Math.max(
    ...['build/Release', `prebuilds/win32-${process.arch}`].map(
      (binDir) => destPath(hostRoot, `${nodePtyRel}/${binDir}/conpty/OpenConsole.exe`).length
    )
  )
}

// Fall back to the install runtime when a deeper copy would prevent terminal startup.
export function daemonHostFitsPathBudget(sources: DaemonHostSources, hostRoot: string): boolean {
  return deepestDaemonHostNativePathLength(sources, hostRoot) <= DAEMON_HOST_NATIVE_PATH_BUDGET
}

function isRuntimeProcessHostPath(packageRel: string): boolean {
  return (
    packageRel === '' ||
    packageRel === 'package.json' ||
    packageRel === 'dist' ||
    packageRel.startsWith('dist/')
  )
}

/** Keep lib siblings and paths leading to required files so the package loader can resolve the addon. */
function isRuntimeProcessTreePath(packageRel: string): boolean {
  return (
    packageRel === '' ||
    packageRel.startsWith('lib/') ||
    WINDOWS_PROCESS_TREE_REQUIRED.some(
      (required) => required === packageRel || required.startsWith(`${packageRel}/`)
    )
  )
}

// Use Windows semantics in both production and tests running on other platforms.
export function toPosixRelative(fromDir: string, absPath: string): string {
  return winPath.relative(fromDir, absPath).split(winPath.sep).join('/')
}

export function destPath(root: string, destRel: string): string {
  return join(root, ...destRel.split('/'))
}

const HOST_WIN_PREBUILD_DIR = `win32-${process.arch}`.toLowerCase()

function isRuntimeNodePtyPath(sourcePath: string): boolean {
  const p = sourcePath.toLowerCase()
  if (p.endsWith('.pdb')) {
    return false
  }
  const prebuild = p.match(/prebuilds[\\/](win32-[^\\/]+)/)
  return !prebuild || prebuild[1] === HOST_WIN_PREBUILD_DIR
}

/** Preserve the packaged relative layout so require() and native loaders resolve the mirror. */
export function buildDaemonHostManifest(sources: DaemonHostSources): CopyOp[] {
  const { appDir, execPath, resourcesPath, entrySourcePath, entryRelPath } = sources
  const ops: CopyOp[] = []

  // Windowless Node mode does not load the omitted top-level GPU/media DLLs.
  ops.push({ sourcePath: execPath, destRel: daemonHostExeName(execPath), kind: 'file' })
  for (const name of RUNTIME_DATA_FILES) {
    ops.push({ sourcePath: join(appDir, name), destRel: name, kind: 'file', optional: true })
  }

  // Preserve sibling chunks and out/package.json for CJS/ESM resolution.
  ops.push({ sourcePath: entrySourcePath, destRel: entryRelPath, kind: 'file' })
  const chunksDir = join(winPath.dirname(entrySourcePath), 'chunks')
  ops.push({
    sourcePath: chunksDir,
    destRel: toPosixRelative(appDir, chunksDir),
    kind: 'dir',
    optional: true
  })
  const pkgJson = join(resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
  ops.push({
    sourcePath: pkgJson,
    destRel: toPosixRelative(appDir, pkgJson),
    kind: 'file',
    optional: true
  })

  // Keep the external package complete so every public subpath shares the same process policy state.
  const processHostDir = daemonHostProcessPackageDir(sources)
  ops.push({
    sourcePath: processHostDir,
    destRel: toPosixRelative(appDir, processHostDir),
    kind: 'dir',
    filter: (sourcePath) => isRuntimeProcessHostPath(toPosixRelative(processHostDir, sourcePath))
  })

  // Keep the native process table runtime to avoid a PowerShell scan per snapshot (#16905).
  const { windowsProcessTreeDir } = sources
  ops.push({
    sourcePath: windowsProcessTreeDir,
    destRel: toPosixRelative(appDir, windowsProcessTreeDir),
    kind: 'dir',
    filter: (sourcePath) =>
      isRuntimeProcessTreePath(toPosixRelative(windowsProcessTreeDir, sourcePath))
  })
  const nodePtyDir = daemonHostNodePtyDir(sources)
  ops.push({
    sourcePath: nodePtyDir,
    destRel: toPosixRelative(appDir, nodePtyDir),
    kind: 'dir',
    filter: isRuntimeNodePtyPath
  })

  return ops
}

export function executeManifest(ops: CopyOp[], stagingRoot: string): void {
  for (const op of ops) {
    if (!existsSync(op.sourcePath)) {
      if (op.optional) {
        continue
      }
      throw new Error(`daemon-host relocation: missing required input ${op.sourcePath}`)
    }
    const dest = destPath(stagingRoot, op.destRel)
    mkdirSync(dirname(dest), { recursive: true })
    const { filter } = op
    // Dereference links so the mirror survives removal of the install directory.
    cpSync(op.sourcePath, dest, {
      recursive: op.kind === 'dir',
      dereference: true,
      force: true,
      ...(filter ? { filter: (src: string) => filter(src) } : {})
    })
  }
}
