import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitExecOptions, type GitWorktreeExecOptions } from '../worktree-operation-options'

const LIST_MAX_BUFFER = 512 * 1024 * 1024
// Bounds in-flight lstats so large repos do not flood libuv's pool for the whole main process.
export const STAT_CONCURRENCY = 32
const NS_PER_S = 1_000_000_000n
const UINT32 = 0xffffffffn
// An index Git writes in the one layout this module patches: fixed-size v2 entries, no shared
// index, every entry present.
const PLAIN_INDEX_CONFIG = [
  '-c',
  'index.version=2',
  '-c',
  'core.splitIndex=false',
  '-c',
  'index.sparse=false',
  '-c',
  'index.skipHash=false'
]

type SourceEntry = {
  mode: string
  oid: string
  ctime: [bigint, bigint]
  mtime: [bigint, bigint]
  ino: bigint
  uid: bigint
  gid: bigint
  size: bigint
  flags: number
}

const SOURCE_ENTRY =
  /(\d{6}) ([0-9a-f]+) (\d)\t([^\0]*)\0 {2}ctime: (\d+):(\d+)\n {2}mtime: (\d+):(\d+)\n {2}dev: \d+\tino: (\d+)\n {2}uid: (\d+)\tgid: (\d+)\n {2}size: (\d+)\tflags: ([0-9a-f]+)\n/g

/** `git read-tree`, writing an index this module can patch. */
export async function readTreeIntoPlainIndex(
  worktreePath: string,
  commit: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  await gitExecFileAsync(
    [...PLAIN_INDEX_CONFIG, 'read-tree', commit],
    gitExecOptions(worktreePath, options)
  )
}

async function git(cwd: string, args: string[], options: GitWorktreeExecOptions) {
  const { stdout } = await gitExecFileAsync(args, {
    ...gitExecOptions(cwd, options),
    maxBuffer: LIST_MAX_BUFFER
  })
  return stdout
}

async function readSourceEntries(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<Map<string, SourceEntry>> {
  const stdout = await git(repoPath, ['ls-files', '--stage', '--debug', '-z'], options)
  const entries = new Map<string, SourceEntry>()
  for (const m of stdout.matchAll(SOURCE_ENTRY)) {
    if (m[3] !== '0') {
      continue
    }
    entries.set(m[4], {
      mode: m[1],
      oid: m[2],
      ctime: [BigInt(m[5]), BigInt(m[6])],
      mtime: [BigInt(m[7]), BigInt(m[8])],
      ino: BigInt(m[9]),
      uid: BigInt(m[10]),
      gid: BigInt(m[11]),
      size: BigInt(m[12]),
      flags: Number.parseInt(m[13], 16)
    })
  }
  return entries
}

const split = (ns: bigint): [bigint, bigint] => [ns / NS_PER_S, ns % NS_PER_S]
const same = (a: [bigint, bigint], b: [bigint, bigint]) => a[0] === b[0] && a[1] === b[1]
const fileMode = (mode: bigint) => ((mode & 0o100n) !== 0n ? '100755' : '100644')

/**
 * Whether Git itself would call the main checkout's file clean without reading it: its stat data
 * matches the index entry and the entry is older than the index, so not "racily clean".
 */
async function isSourceClean(
  path: string,
  entry: SourceEntry,
  indexMtimeSeconds: bigint
): Promise<boolean> {
  if (entry.flags !== 0 || entry.mtime[0] >= indexMtimeSeconds) {
    return false
  }
  const stat = await lstat(path, { bigint: true }).catch(() => null)
  return (
    stat !== null &&
    stat.isFile() &&
    fileMode(stat.mode) === entry.mode &&
    same(split(stat.mtimeNs), entry.mtime) &&
    same(split(stat.ctimeNs), entry.ctime) &&
    (stat.ino & UINT32) === entry.ino &&
    (stat.size & UINT32) === entry.size &&
    stat.uid === entry.uid &&
    stat.gid === entry.gid
  )
}

type TargetEntry = { offset: number; path: string; mode: string; oid: string }

function parsePlainIndex(index: Buffer, hashLength: number): TargetEntry[] | null {
  if (index.toString('latin1', 0, 4) !== 'DIRC' || index.readUInt32BE(4) !== 2) {
    return null
  }
  const count = index.readUInt32BE(8)
  const fixed = 40 + hashLength + 2
  const entries: TargetEntry[] = []
  let offset = 12
  for (let i = 0; i < count; i++) {
    const flags = index.readUInt16BE(offset + fixed - 2)
    if ((flags & 0x7000) !== 0) {
      return null
    }
    const nameStart = offset + fixed
    const nameEnd = index.indexOf(0, nameStart)
    if (nameEnd === -1) {
      return null
    }
    entries.push({
      offset,
      path: index.toString('utf8', nameStart, nameEnd),
      mode: index.readUInt32BE(offset + 24).toString(8),
      oid: index.toString('hex', offset + 40, offset + 40 + hashLength)
    })
    offset += (fixed + (nameEnd - nameStart) + 8) & ~7
  }
  return entries
}

function writeStat(index: Buffer, offset: number, stat: BigIntStats): void {
  const fields = [
    ...split(stat.ctimeNs),
    ...split(stat.mtimeNs),
    stat.dev,
    stat.ino,
    null,
    stat.uid,
    stat.gid,
    stat.size
  ]
  fields.forEach((value, i) => {
    if (value !== null) {
      index.writeUInt32BE(Number(value & UINT32), offset + i * 4)
    }
  })
}

/**
 * Records real stat data in a freshly read-tree'd worktree index for files cloned from the main
 * checkout, where Git's own index proves the source file matches the blob. Git then skips
 * re-reading those files on its next refresh instead of hashing the whole tree. Every file it
 * cannot prove is left for Git to read. Returns how many entries it recorded.
 */
export async function transferCleanIndexStats(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<number> {
  const [worktreeConfig, objectFormat, sourceIndexPath, indexPath] = await Promise.all([
    git(repoPath, ['config', '--bool', 'extensions.worktreeConfig'], options).catch(() => ''),
    git(worktreePath, ['rev-parse', '--show-object-format'], options),
    git(repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], options),
    git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], options)
  ])
  // Per-worktree config could change how files convert on checkout.
  if (worktreeConfig.trim() === 'true') {
    return 0
  }
  // Git's own handshake: whoever creates index.lock owns the index until it renames it.
  const lockPath = `${indexPath.trim()}.lock`
  const lock = await open(lockPath, 'wx').catch(() => null)
  if (!lock) {
    return 0
  }
  try {
    const recorded = await recordCleanStats(
      repoPath,
      worktreePath,
      indexPath.trim(),
      sourceIndexPath.trim(),
      objectFormat.trim() === 'sha256' ? 32 : 20,
      options
    )
    if (recorded.count > 0) {
      await lock.writeFile(recorded.index)
    }
    await lock.close()
    await (recorded.count > 0 ? rename(lockPath, indexPath.trim()) : rm(lockPath, { force: true }))
    return recorded.count
  } catch (error) {
    await lock.close().catch(() => {})
    await rm(lockPath, { force: true })
    throw error
  }
}

async function recordCleanStats(
  repoPath: string,
  worktreePath: string,
  indexPath: string,
  sourceIndexPath: string,
  hashLength: number,
  options: GitWorktreeExecOptions
): Promise<{ count: number; index: Buffer }> {
  const indexMtime = (await lstat(sourceIndexPath, { bigint: true })).mtimeNs / NS_PER_S
  const [sources, index] = await Promise.all([
    readSourceEntries(repoPath, options),
    readFile(indexPath)
  ])
  const targets = parsePlainIndex(index, hashLength)
  if (!targets) {
    return { count: 0, index }
  }

  // Equal attributes mean Git converts both checkouts' files the same way.
  const attributePaths = new Set(
    [...sources.keys(), ...targets.map((t) => t.path)].filter(
      (path) => basename(path) === '.gitattributes'
    )
  )
  for (const path of attributePaths) {
    const source = sources.get(path)
    const target = targets.find((t) => t.path === path)
    if (
      !source ||
      !target ||
      source.oid !== target.oid ||
      !(await isSourceClean(join(repoPath, path), source, indexMtime))
    ) {
      return { count: 0, index }
    }
  }

  let recorded = 0
  await forEachWithConcurrency(targets, STAT_CONCURRENCY, async (target) => {
    const source = sources.get(target.path)
    if (
      !source ||
      source.oid !== target.oid ||
      source.mode !== target.mode ||
      target.path.includes('�') ||
      !(await isSourceClean(join(repoPath, target.path), source, indexMtime))
    ) {
      return
    }
    const clone = await lstat(join(worktreePath, target.path), { bigint: true }).catch(() => null)
    // A clone keeps its source's size and mtime; anything else was not cloned from that file.
    if (
      !clone?.isFile() ||
      fileMode(clone.mode) !== target.mode ||
      (clone.size & UINT32) !== source.size ||
      !same(split(clone.mtimeNs), source.mtime)
    ) {
      return
    }
    writeStat(index, target.offset, clone)
    recorded++
  })
  if (recorded > 0) {
    createHash(hashLength === 32 ? 'sha256' : 'sha1')
      .update(index.subarray(0, index.length - hashLength))
      .digest()
      .copy(index, index.length - hashLength)
  }
  return { count: recorded, index }
}
