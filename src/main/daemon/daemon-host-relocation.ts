import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, win32 as winPath } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { quarantineCorruptDaemonPidRecord } from './daemon-pid-record-quarantine'
import { inspectProcessLiveness, mergeProcessLivenessVerdict } from './daemon-process-inspection'

/**
 * Relocate the terminal daemon's process image out of the app install dir into LOCAL userData so it
 * survives Windows auto-updates: the NSIS installer deletes the old install and force-kills every process
 * imaged under it, which would otherwise kill the daemon and its live terminals. The relocated exe is a
 * run-as-node Orca.exe copy (not node.exe) so there's no console flash and asar still resolves. Fail-open:
 * any failure returns null and the caller forks the install-dir host (pre-relocation behavior).
 */

export type RelocatedDaemonHost = {
  /** The relocated host exe to fork the daemon from (run as node). */
  execPath: string
  /** The copied daemon-entry.js, mirrored under the relocated resources tree. */
  entryPath: string
}

const HOST_SUBDIR = 'daemon-host'
const MARKER_NAME = '.materialized.json'

// LOCAL appData (not roaming) so OneDrive/roaming never syncs this ~260MB runtime. Shared with NSIS uninstall (config/nsis/daemon-host-uninstall.nsh) — keep in sync.
const LOCAL_HOST_ROOT_NAME = 'Orca'

// Copy of Orca.exe renamed to a distinct image name so the NSIS updater's `taskkill /IM Orca.exe` can't match it.
const DAEMON_HOST_EXE_NAME = 'orca-terminal-daemon.exe'

// V8 snapshots + ICU data the Electron bootstrap reads even under ELECTRON_RUN_AS_NODE; siblings of Orca.exe.
const RUNTIME_DATA_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']

type CopyOp = {
  sourcePath: string
  /** Destination path relative to the host root, posix-separated. */
  destRel: string
  kind: 'file' | 'dir'
  /** When true, a missing source is skipped rather than failing the copy. */
  optional?: boolean
  /** Per-source-path predicate for dir copies: return false to skip a path. */
  filter?: (sourcePath: string) => boolean
}

type DaemonHostSources = {
  appDir: string
  execPath: string
  resourcesPath: string
  entrySourcePath: string
  entryRelPath: string
}

type MaterializeMarker = {
  version: string
  completedAt: string
  entryRelPath: string
}

// win32 path semantics so Windows paths decompose correctly off-win32 in cross-platform unit tests; production runs on win32 only.
function toPosixRelative(fromDir: string, absPath: string): string {
  return winPath.relative(fromDir, absPath).split(winPath.sep).join('/')
}

function destPath(root: string, destRel: string): string {
  return join(root, ...destRel.split('/'))
}

// Mirror getDaemonEntryPath()'s resolution order so the copied entry is the exact file the in-dir fork would run.
function resolveEntrySourcePath(resourcesPath: string): string {
  const unpackedRoot = join(resourcesPath, 'app.asar.unpacked')
  const direct = join(unpackedRoot, 'daemon-entry.js')
  if (existsSync(direct)) {
    return direct
  }
  return join(unpackedRoot, 'out', 'main', 'daemon-entry.js')
}

/**
 * Whether this process is a packaged ELECTRON app on win32 — the only shape relocation
 * addresses, because what it escapes is the NSIS updater's kill zone.
 *
 * Why asar and not isPackaged alone: orcad answers isPackaged() true (it is a shipped build,
 * not a dev checkout) while having no asar, no resourcesPath and no NSIS installer. Asking
 * whether the app root is an asar archive is the same honesty fix the watcher path uses, and
 * it keeps a Node host from staging a copy of an Electron tree it does not have.
 */
function isPackagedElectronWin32(): boolean {
  const environment = getAppEnvironment()
  return (
    process.platform === 'win32' &&
    environment.isPackaged() &&
    environment.getAppPath().includes('app.asar')
  )
}

// Relocation inputs from the live packaged process, or null when it doesn't apply (non-win32, dev, or missing resourcesPath).
function collectDaemonHostSources(): DaemonHostSources | null {
  if (!isPackagedElectronWin32()) {
    return null
  }
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
    return null
  }
  const execPath = process.execPath
  const appDir = winPath.dirname(execPath)
  const entrySourcePath = resolveEntrySourcePath(resourcesPath)
  return {
    appDir,
    execPath,
    resourcesPath,
    entrySourcePath,
    entryRelPath: toPosixRelative(appDir, entrySourcePath)
  }
}

// Drop node-pty's .pdb symbols and non-host-arch prebuilds (its bulk); keyed on host arch so a future win32-arm64 build keeps the prebuild it needs.
const HOST_WIN_PREBUILD_DIR = `win32-${process.arch}`.toLowerCase()
function isRuntimeNodePtyPath(sourcePath: string): boolean {
  const p = sourcePath.toLowerCase()
  if (p.endsWith('.pdb')) {
    return false
  }
  // Keep only the host arch's win32 prebuild; drop any other win32-<arch> dir.
  const prebuild = p.match(/prebuilds[\\/](win32-[^\\/]+)/)
  return !prebuild || prebuild[1] === HOST_WIN_PREBUILD_DIR
}

/**
 * The ordered copy plan. Every destRel mirrors the source's win-unpacked relative path so require()
 * and node-pty's loader resolve the mirror identically to the packaged app. Pure so tests can assert layout.
 */
export function buildDaemonHostManifest(sources: DaemonHostSources): CopyOp[] {
  const { appDir, execPath, resourcesPath, entrySourcePath, entryRelPath } = sources
  const ops: CopyOp[] = []

  // Host exe (renamed) + V8/ICU blobs at dest root. Top-level DLLs omitted: GPU/media libs a windowless run-as-node host never loads (~48MB saved).
  ops.push({ sourcePath: execPath, destRel: DAEMON_HOST_EXE_NAME, kind: 'file' })
  for (const name of RUNTIME_DATA_FILES) {
    ops.push({ sourcePath: join(appDir, name), destRel: name, kind: 'file', optional: true })
  }

  // Daemon bundle: entry + sibling chunks/ + out/package.json (CJS/ESM loader resolution), mirrored verbatim.
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

  // node-pty tree, mirrored so require('node-pty') resolves it; filtered to drop unused .pdb/other-arch prebuilds.
  const nodePtyDir = join(resourcesPath, 'node_modules', 'node-pty')
  ops.push({
    sourcePath: nodePtyDir,
    destRel: toPosixRelative(appDir, nodePtyDir),
    kind: 'dir',
    filter: isRuntimeNodePtyPath
  })

  return ops
}

function executeManifest(ops: CopyOp[], stagingRoot: string): void {
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
    // Dereference symlinks so the copy holds no link back into the install dir.
    cpSync(op.sourcePath, dest, {
      recursive: op.kind === 'dir',
      dereference: true,
      force: true,
      ...(filter ? { filter: (src: string) => filter(src) } : {})
    })
  }
}

function readMarker(dir: string): MaterializeMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, MARKER_NAME), 'utf8')
    ) as Partial<MaterializeMarker>
    if (typeof parsed.version === 'string' && typeof parsed.entryRelPath === 'string') {
      return {
        version: parsed.version,
        completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : '',
        entryRelPath: parsed.entryRelPath
      }
    }
  } catch {
    // Missing/corrupt marker — treat as not materialized.
  }
  return null
}

function hostRootDir(): string {
  // Prefer LOCAL appData (see LOCAL_HOST_ROOT_NAME); fall back to userData only if LOCALAPPDATA is unset.
  const localAppData = process.env.LOCALAPPDATA
  const base =
    typeof localAppData === 'string' && localAppData.length > 0
      ? join(localAppData, LOCAL_HOST_ROOT_NAME)
      : getAppEnvironment().getPath('userData')
  return join(base, HOST_SUBDIR)
}

/**
 * The relocated host for the current version, or null. Valid only when the marker matches this version
 * AND the exe + entry exist, so a partial or stale copy never reports ready.
 */
export function getRelocatedDaemonHost(): RelocatedDaemonHost | null {
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  const version = getAppEnvironment().getVersion()
  const dest = join(hostRootDir(), version)
  const marker = readMarker(dest)
  if (!marker || marker.version !== version) {
    return null
  }
  const execPath = join(dest, DAEMON_HOST_EXE_NAME)
  const entryPath = destPath(dest, marker.entryRelPath)
  if (!existsSync(execPath) || !existsSync(entryPath)) {
    return null
  }
  return { execPath, entryPath }
}

/**
 * Materialize the current version's daemon host, returning its fork paths or null (fail-open). Idempotent
 * via marker; stages into a temp sibling and publishes by atomic rename, so a crash mid-copy never leaves a half-populated dest.
 */
export function materializeRelocatedDaemonHost(): RelocatedDaemonHost | null {
  const existing = getRelocatedDaemonHost()
  if (existing) {
    return existing
  }
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  const version = getAppEnvironment().getVersion()
  const root = hostRootDir()
  const dest = join(root, version)
  const staging = join(root, `${version}.staging-${randomBytes(6).toString('hex')}`)
  try {
    mkdirSync(root, { recursive: true })
    rmSync(staging, { recursive: true, force: true })
    executeManifest(buildDaemonHostManifest(sources), staging)
    // Marker written LAST so an interrupted copy leaves a marker-less staging dir the next launch discards.
    const marker: MaterializeMarker = {
      version,
      completedAt: new Date().toISOString(),
      entryRelPath: sources.entryRelPath
    }
    writeFileSync(join(staging, MARKER_NAME), JSON.stringify(marker))
    // Replace any stale/partial dest, then publish the staging dir atomically.
    rmSync(dest, { recursive: true, force: true })
    renameSync(staging, dest)
  } catch {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Best-effort staging cleanup.
    }
    return null
  }
  return getRelocatedDaemonHost()
}

export type PinnedDaemonVersionsEvidence =
  | { status: 'complete'; versionLiveness: ReadonlyMap<string, ProcessLivenessVerdict> }
  | { status: 'unverifiable'; reason: string }

/**
 * App versions still pinned by a live daemon (from daemon-v<N>.pid files under `runtimeDir`), whose
 * host dir must not be reclaimed while alive. On win32 start-time can't verify, so a matching pid pins conservatively.
 */
export function collectPinnedDaemonVersions(runtimeDir: string): PinnedDaemonVersionsEvidence {
  const versionLiveness = new Map<string, ProcessLivenessVerdict>()
  let entries
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true })
  } catch {
    return { status: 'unverifiable', reason: 'the daemon runtime directory could not be read' }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^daemon-v\d+\.pid$/.test(entry.name)) {
      continue
    }
    let contents
    try {
      contents = readFileSync(join(runtimeDir, entry.name), 'utf8')
    } catch {
      // Read failures (AV lock, vanished file) are transient; the veto re-evaluates next launch.
      return {
        status: 'unverifiable',
        reason: `the daemon pid file could not be read: ${entry.name}`
      }
    }
    const parsed = parseDaemonPidFile(contents)
    // Why not just `!parsed`: the parser's legacy bare-integer fallback coerces an empty or
    // whitespace-only record to pid 0 (Number('') === 0), which is the exact shape a concurrent
    // read sees while a live daemon publishes its record — writeFileSync 'wx' creates the file
    // before writing it. Such a record would otherwise pass as a valid pre-relocation daemon,
    // skip on appVersion === null, and leave its version unpinned, so the prune below would
    // reclaim a running daemon's host image. A pid that is not a positive integer names no
    // process — process.kill(0, 0) probes the caller's own process group, never a daemon — so
    // it is not liveness evidence and must veto rather than be skipped.
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return {
        status: 'unverifiable',
        reason: quarantineCorruptDaemonPidRecord(runtimeDir, entry.name, contents)
      }
    }
    // appVersion null => pre-relocation daemon forked from the install dir; pins no host dir here.
    if (parsed.appVersion === null) {
      continue
    }
    const verdict = inspectProcessLiveness(parsed.pid)
    versionLiveness.set(
      parsed.appVersion,
      mergeProcessLivenessVerdict(versionLiveness.get(parsed.appVersion), verdict)
    )
  }
  return { status: 'complete', versionLiveness }
}

// Why: deletion is the destructive direction and this is a statement position the compiler does
// not police for exhaustiveness — reclaim must be opted into by a positively matched 'exited',
// so any future unhandled verdict status preserves the host dir instead of deleting it.
export function reclaimUnownedDaemonHostDir(
  verdict: ProcessLivenessVerdict,
  hostDir: string
): void {
  if (verdict.status !== 'exited') {
    return
  }
  try {
    rmSync(hostDir, { recursive: true, force: true })
  } catch {
    // Still locked or already gone — retry on a future launch.
  }
}

/**
 * Reclaim daemon-host/<ver> dirs that are neither the current version nor pinned by a live daemon.
 * Best-effort — never throws; a locked/staging dir is retried on a future launch.
 */
export function pruneOldDaemonHosts(evidence: PinnedDaemonVersionsEvidence): void {
  if (!isPackagedElectronWin32()) {
    return
  }
  if (evidence.status === 'unverifiable') {
    console.warn(`[daemon] Skipping daemon-host prune: ${evidence.reason}`)
    return
  }
  const version = getAppEnvironment().getVersion()
  const root = hostRootDir()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === version) {
      continue
    }
    // A complete runtime-dir listing with no pid record for this version proves it is unowned.
    const verdict = evidence.versionLiveness.get(entry.name) ?? { status: 'exited' }
    reclaimUnownedDaemonHostDir(verdict, join(root, entry.name))
  }
}
