import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { fileStatSignature } from '../../../filesystem/file-stat-signature'
import { seedDaemonHostFileHash } from './daemon-host-file-hash-cache'
import { mapWithConcurrencyUntilFailure } from '../../../../shared/concurrency/map-with-concurrency'
import {
  DAEMON_HOST_FS_CONCURRENCY,
  listDaemonHostTree,
  type TreeEntry
} from './daemon-host-tree-walk'
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

export const WINDOWS_REGISTRY_REQUIRED = [
  'package.json',
  'index.js',
  'build/Release/orca_windows_registry.node'
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

export function daemonHostWindowsRegistryDir(sources: DaemonHostSources): string {
  return join(sources.resourcesPath, 'node_modules', '@orca', 'windows-registry')
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

function isRequiredRuntimePath(packageRel: string, requiredFiles: readonly string[]): boolean {
  return (
    packageRel === '' ||
    requiredFiles.some(
      (required) => required === packageRel || required.startsWith(`${packageRel}/`)
    )
  )
}

/** Keep lib siblings and paths leading to required files so the package loader can resolve the addon. */
function isRuntimeProcessTreePath(packageRel: string): boolean {
  return (
    packageRel.startsWith('lib/') ||
    isRequiredRuntimePath(packageRel, WINDOWS_PROCESS_TREE_REQUIRED)
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
  const registryDir = daemonHostWindowsRegistryDir(sources)
  ops.push({
    sourcePath: registryDir,
    destRel: toPosixRelative(appDir, registryDir),
    kind: 'dir',
    filter: (sourcePath) =>
      isRequiredRuntimePath(toPosixRelative(registryDir, sourcePath), WINDOWS_REGISTRY_REQUIRED)
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

async function sourceSignature(sourcePath: string): Promise<string> {
  return fileStatSignature(await stat(sourcePath, { bigint: true }))
}

// Hash the bytes written; rereading a just-written file waits on Defender's scan of it.
async function copyHashedFile(
  sourcePath: string,
  dest: string,
  expected: string | undefined
): Promise<{ sha256: string; signature: string }> {
  const signature = await sourceSignature(sourcePath)
  const bytes = await readFile(sourcePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (expected !== undefined && sha256 !== expected) {
    throw new Error('daemon-host relocation: code changed while copying')
  }
  await writeFile(dest, bytes)
  return { sha256, signature }
}

// A file added or removed under the code after listing would publish an incomplete build.
async function assertCodeDirsUnchanged(
  codeDirs: readonly TreeEntry[],
  listed: readonly TreeEntry[]
): Promise<void> {
  const listedRels = new Set(listed.map((entry) => entry.destRel))
  await mapWithConcurrencyUntilFailure(codeDirs, DAEMON_HOST_FS_CONCURRENCY, async (dir) => {
    const names = (await readdir(dir.sourcePath)).filter(
      (name) => !dir.filter || dir.filter(join(dir.sourcePath, name))
    )
    const listedCount = [...listedRels].filter(
      (rel) => rel.startsWith(`${dir.destRel}/`) && !rel.slice(dir.destRel.length + 1).includes('/')
    ).length
    if (
      names.length !== listedCount ||
      names.some((name) => !listedRels.has(`${dir.destRel}/${name}`))
    ) {
      throw new Error('daemon-host relocation: code changed while copying')
    }
  })
}

export type ManifestCodeHashing = {
  /** Posix destRels whose copied bytes are hashed and returned. */
  isCode: (destRel: string) => boolean
  /** When given, every code file must match; a fresh copy omits it and records what it copied. */
  expected?: ReadonlyMap<string, string>
}

/**
 * Copy through libuv so the ~1.8k-file, ~275 MiB runtime doesn't hold Electron main; only per-file hashing runs there.
 * Returns the sha256 of every code file, taken from the bytes written.
 */
export async function executeManifest(
  ops: CopyOp[],
  stagingRoot: string,
  code: ManifestCodeHashing = { isCode: () => false }
): Promise<Map<string, string>> {
  const exists = await mapWithConcurrencyUntilFailure(ops, DAEMON_HOST_FS_CONCURRENCY, (op) =>
    access(op.sourcePath).then(
      () => true,
      () => false
    )
  )
  const present = ops.filter((_, index) => exists[index])
  const missing = ops.find((op) => !op.optional && !present.includes(op))
  if (missing) {
    throw new Error(`daemon-host relocation: missing required input ${missing.sourcePath}`)
  }
  const { files, dirs } = await listDaemonHostTree(present, DAEMON_HOST_FS_CONCURRENCY)
  const codeFiles = files.filter((file) => code.isCode(file.destRel))
  if (code.expected && code.expected.size !== codeFiles.length) {
    throw new Error('daemon-host relocation: copied code does not match its fingerprint')
  }
  // Keep accepted empty directories, matching the recursive copy this replaced.
  const destDirs = new Set([
    ...dirs.map((dir) => destPath(stagingRoot, dir.destRel)),
    ...files.map((file) => dirname(destPath(stagingRoot, file.destRel)))
  ])
  for (const dir of destDirs) {
    await mkdir(dir, { recursive: true })
  }
  const hashes = new Map<string, string>()
  const signatures = new Map<string, { signature: string; sha256: string }>()
  // Settles in-flight copies before failing, so staging cleanup cannot race a copy still writing.
  await mapWithConcurrencyUntilFailure(files, DAEMON_HOST_FS_CONCURRENCY, async (file) => {
    const dest = destPath(stagingRoot, file.destRel)
    if (!code.isCode(file.destRel)) {
      await copyFile(file.sourcePath, dest)
      return
    }
    const expected = code.expected?.get(file.destRel)
    if (code.expected && expected === undefined) {
      throw new Error(`daemon-host relocation: ${file.destRel} is outside the fingerprint`)
    }
    const copied = await copyHashedFile(file.sourcePath, dest, expected)
    hashes.set(file.destRel, copied.sha256)
    signatures.set(file.sourcePath, { signature: copied.signature, sha256: copied.sha256 })
  })
  await assertCodeDirsUnchanged(
    dirs.filter((dir) => code.isCode(dir.destRel)),
    [...files, ...dirs]
  )
  // An optional code root (chunks) that an update creates mid-copy would leave the copy without it.
  const absentCode = ops.filter((op, index) => !exists[index] && code.isCode(op.destRel))
  if (
    (
      await mapWithConcurrencyUntilFailure(absentCode, DAEMON_HOST_FS_CONCURRENCY, (op) =>
        access(op.sourcePath).then(
          () => true,
          () => false
        )
      )
    ).some(Boolean)
  ) {
    throw new Error('daemon-host relocation: code changed while copying')
  }
  // A source replaced after it was read (an update mid-copy) would mix revisions in one build.
  await mapWithConcurrencyUntilFailure(
    [...signatures],
    DAEMON_HOST_FS_CONCURRENCY,
    async ([path, before]) => {
      if ((await sourceSignature(path)) !== before.signature) {
        throw new Error('daemon-host relocation: code changed while copying')
      }
    }
  )
  // Sources proved unchanged across their read; seed the cache so a later sync lookup doesn't reread them on main.
  for (const [path, { signature, sha256 }] of signatures) {
    seedDaemonHostFileHash(path, signature, sha256)
  }
  return hashes
}
