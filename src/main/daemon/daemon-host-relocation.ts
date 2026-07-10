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
import { app } from 'electron'
import { parseDaemonPidFile, startTimeMatches } from './daemon-health'

/**
 * Relocates the terminal daemon's process image out of the app install
 * directory into userData so it survives Windows auto-updates.
 *
 * Why: the daemon is forked as plain Node via ELECTRON_RUN_AS_NODE, so its
 * image is the install-dir Orca.exe and its loaded modules (node-pty native,
 * ConPTY runtime) map from the install dir. On update, electron-builder's NSIS
 * installer deletes the old install and force-closes every process whose image
 * lives under it — killing the daemon and every live terminal it owns. Copying
 * the daemon's whole file closure to a version-keyed userData dir and forking
 * from that copy takes its image + loaded modules out of the installer's reach.
 *
 * The copy keeps the ELECTRON binary run as node (not stock node.exe): a copy
 * of Orca.exe (renamed to a distinct image name) is byte-identical, so
 * run-as-node behavior — no console flashing, asar-correct — matches the in-dir
 * fork exactly. The win-unpacked layout is mirrored verbatim so
 * require('node-pty') and node-pty's native loader resolve the relocated tree
 * identically to the packaged app.
 *
 * Fail-open everywhere: any failure returns null and the caller forks the
 * install-dir host — the pre-relocation behavior, byte-identical off win32.
 */

export type RelocatedDaemonHost = {
  /** The relocated host exe to fork the daemon from (run as node). */
  execPath: string
  /** The copied daemon-entry.js, mirrored under the relocated resources tree. */
  entryPath: string
}

const HOST_SUBDIR = 'daemon-host'
const MARKER_NAME = '.materialized.json'

// The relocated host is machine-specific runtime (~260MB). It must live under
// LOCAL appData, not the roaming userData dir, so a roaming profile or OneDrive
// Known-Folder-Move never syncs it (slow login/logout, sync bloat). This folder
// name is shared verbatim with the NSIS uninstall cleanup
// (config/nsis/daemon-host-uninstall.nsh), which removes
// %LOCALAPPDATA%\<LOCAL_HOST_ROOT_NAME>\daemon-host — keep the two in sync.
const LOCAL_HOST_ROOT_NAME = 'Orca'

// The relocated host exe is a copy of Orca.exe renamed to a distinct image
// name. The NSIS updater's name-based kill (`taskkill /IM Orca.exe`) matches by
// image name, so a distinct name spares the daemon from that branch, while the
// userData path (outside $INSTDIR) spares it from the path-based branch.
const DAEMON_HOST_EXE_NAME = 'orca-terminal-daemon.exe'

// V8 snapshots + ICU data the Electron bootstrap reads even under
// ELECTRON_RUN_AS_NODE; siblings of Orca.exe in win-unpacked.
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

// Uses win32 path semantics so Windows layout paths (drive letters, `\`)
// decompose correctly regardless of host OS — needed for cross-platform unit
// tests; production runs this on win32 only.
function toPosixRelative(fromDir: string, absPath: string): string {
  return winPath.relative(fromDir, absPath).split(winPath.sep).join('/')
}

function destPath(root: string, destRel: string): string {
  return join(root, ...destRel.split('/'))
}

// Mirror getDaemonEntryPath()'s resolution order (unpacked root first, then
// out/main) so the copied entry is the exact file the in-dir fork would run.
function resolveEntrySourcePath(resourcesPath: string): string {
  const unpackedRoot = join(resourcesPath, 'app.asar.unpacked')
  const direct = join(unpackedRoot, 'daemon-entry.js')
  if (existsSync(direct)) {
    return direct
  }
  return join(unpackedRoot, 'out', 'main', 'daemon-entry.js')
}

// Discover the relocation inputs from the live packaged process, or null when
// relocation does not apply (non-win32, dev, or missing resourcesPath).
function collectDaemonHostSources(): DaemonHostSources | null {
  if (process.platform !== 'win32' || !app.isPackaged) {
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

// node-pty ships debug symbols (.pdb) and a win32 prebuild dir per CPU arch; the
// run-as-node daemon loads neither the symbols nor any non-host-arch prebuild
// (verified against the live daemon's loaded module list), so they are filtered
// out of the copy — the bulk of node-pty's on-disk size. Keyed on the host arch
// rather than dropping arm64 outright so a future Windows-arm64 build keeps the
// `win32-arm64` prebuild it actually needs and prunes `win32-x64` instead.
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
 * The ordered copy plan. Every destRel mirrors the source's win-unpacked
 * relative path so require() and node-pty's native loader resolve the mirror
 * identically to the packaged app. Pure over its inputs so tests can assert the
 * layout without a real build.
 */
export function buildDaemonHostManifest(sources: DaemonHostSources): CopyOp[] {
  const { appDir, execPath, resourcesPath, entrySourcePath, entryRelPath } = sources
  const ops: CopyOp[] = []

  // Electron host binary + V8/ICU data blobs at the dest root. The exe is
  // renamed to a distinct image name so the NSIS updater's name-based
  // `taskkill /IM Orca.exe` can't match it; the blobs beside it are read by the
  // Electron bootstrap by fixed name. Top-level DLLs are deliberately NOT copied
  // — they are all GPU/graphics/media (swiftshader, vulkan, d3d, dxcompiler,
  // ffmpeg) that a windowless run-as-node host never loads (verified empirically
  // against the live daemon's module list), so copying them only wastes ~48MB.
  ops.push({ sourcePath: execPath, destRel: DAEMON_HOST_EXE_NAME, kind: 'file' })
  for (const name of RUNTIME_DATA_FILES) {
    ops.push({ sourcePath: join(appDir, name), destRel: name, kind: 'file', optional: true })
  }

  // Daemon bundle: entry + its sibling chunks/ + the unpacked out/package.json
  // (CJS/ESM loader resolution), mirrored verbatim.
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

  // node-pty package tree (native conpty.node + conpty/ runtime dir). It is a
  // sibling of app.asar.unpacked; require('node-pty') resolves it by walking up
  // from the mirrored daemon-entry dir to resources/node_modules. Filtered to
  // drop .pdb debug symbols and other-arch prebuilds the host never loads.
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
  // Prefer LOCAL appData (see LOCAL_HOST_ROOT_NAME). Fall back to userData only
  // if LOCALAPPDATA is somehow unset — a no-op off win32, where relocation never
  // runs anyway; on win32 packaged the env var is always present.
  const localAppData = process.env.LOCALAPPDATA
  const base =
    typeof localAppData === 'string' && localAppData.length > 0
      ? join(localAppData, LOCAL_HOST_ROOT_NAME)
      : app.getPath('userData')
  return join(base, HOST_SUBDIR)
}

/**
 * Cheap idempotency check: the relocated host for the current version, or null.
 * Valid only when the marker matches this version AND the exe + entry exist, so
 * a partial or stale copy never reports ready.
 */
export function getRelocatedDaemonHost(): RelocatedDaemonHost | null {
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  const version = app.getVersion()
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
 * Ensure the current version's daemon host is materialized under
 * userData/daemon-host/<version>, returning its fork paths or null (fail-open).
 * Idempotent: a valid marker for this version short-circuits without recopying.
 * The copy stages into a temp sibling and is published by atomic rename, so a
 * crash mid-copy never leaves a half-populated dest.
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
  const version = app.getVersion()
  const root = hostRootDir()
  const dest = join(root, version)
  const staging = join(root, `${version}.staging-${randomBytes(6).toString('hex')}`)
  try {
    mkdirSync(root, { recursive: true })
    rmSync(staging, { recursive: true, force: true })
    executeManifest(buildDaemonHostManifest(sources), staging)
    // Marker written LAST: an interrupted copy leaves a marker-less staging dir
    // that the next launch discards, never a dest the cheap check trusts.
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

function isDaemonPidAlive(pid: number, startedAtMs: number | null): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return startTimeMatches(pid, startedAtMs)
}

/**
 * App versions still pinned by a live daemon, read from the daemon-v<N>.pid
 * files under `runtimeDir`. A surviving daemon runs from its version's host dir,
 * so its dir must never be reclaimed while the process is alive. On win32 the
 * start-time check cannot verify, so a matching pid pins conservatively.
 */
export function collectPinnedDaemonVersions(runtimeDir: string): Set<string> {
  const pinned = new Set<string>()
  let entries
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true })
  } catch {
    return pinned
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^daemon-v\d+\.pid$/.test(entry.name)) {
      continue
    }
    let parsed
    try {
      parsed = parseDaemonPidFile(readFileSync(join(runtimeDir, entry.name), 'utf8'))
    } catch {
      continue
    }
    // appVersion null => a pre-relocation daemon forked from the install dir,
    // which pins no host dir here.
    if (parsed && parsed.appVersion !== null && isDaemonPidAlive(parsed.pid, parsed.startedAtMs)) {
      pinned.add(parsed.appVersion)
    }
  }
  return pinned
}

/**
 * Reclaim daemon-host/<ver> dirs whose ver is neither the current version nor
 * pinned by a live daemon. Best-effort — never throws; a still-locked or
 * concurrently-staging dir is simply retried on a future launch.
 */
export function pruneOldDaemonHosts(pinnedVersions: ReadonlySet<string>): void {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return
  }
  const version = app.getVersion()
  const root = hostRootDir()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === version || pinnedVersions.has(entry.name)) {
      continue
    }
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true })
    } catch {
      // Still locked or already gone — retry on a future launch.
    }
  }
}
