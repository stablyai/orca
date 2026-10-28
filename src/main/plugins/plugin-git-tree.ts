import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExecFileAsyncBuffer } from '../git/runner'
import { pluginGitTreeArgs } from '../../shared/plugins/plugin-git-arguments'
import { pluginRelativePathError } from '../../shared/plugins/plugin-path-safety'
import { MAX_PLUGIN_FILES, MAX_PLUGIN_TOTAL_BYTES } from './plugin-content-hash'

const MAX_PATH_BYTES = 1024
const MAX_PATH_DEPTH = 64
const TREE_METADATA_MAX_BYTES = MAX_PLUGIN_FILES * (MAX_PATH_BYTES + 128)
const PLUGIN_GIT_TREE_TIMEOUT_MS = 120_000

export type PluginGitTreeEntry =
  | { kind: 'tree'; path: string }
  | { kind: 'blob'; path: string; object: string; size: number; executable: boolean }

// Why: case-insensitive and NFC-normalizing filesystems (macOS, Windows) merge these; the
// upper-then-lower round trip approximates full case folding (e.g. ß/ẞ, Kelvin sign).
function portablePathIdentity(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase()
}

function validatePath(path: string): void {
  const segments = path.split('/')
  if (
    pluginRelativePathError(path) ||
    path.includes('\\') ||
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES ||
    segments.length > MAX_PATH_DEPTH ||
    segments.some((segment) => {
      // Why: HFS+ ignores these code points and NTFS 8.3 names alias `.git`.
      const name = portablePathIdentity(segment).replace(/[‌-‏‪-‮⁪-⁯﻿]/g, '')
      return name === '.git' || /^\.?git~[0-9]+$/.test(name)
    })
  ) {
    throw new Error(`unsafe plugin path: ${path}`)
  }
}

/** Parses `git ls-tree -r -t -l -z` output; anything but plain files and directories is refused. */
export function parsePluginGitTree(bytes: Buffer): PluginGitTreeEntry[] {
  if (bytes.length > TREE_METADATA_MAX_BYTES) {
    throw new Error('plugin Git tree metadata exceeds its size limit')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text && !text.endsWith('\0')) {
    throw new Error('truncated plugin Git tree metadata')
  }
  const records = text ? text.slice(0, -1).split('\0') : []
  if (records.length > MAX_PLUGIN_FILES) {
    throw new Error(`plugin exceeds the ${MAX_PLUGIN_FILES}-entry limit`)
  }
  const entries: PluginGitTreeEntry[] = []
  const kinds = new Map<string, PluginGitTreeEntry['kind']>()
  const portablePaths = new Set<string>()
  let totalBytes = 0
  for (const record of records) {
    const match = /^(040000|100644|100755) (tree|blob) ([0-9a-f]{40}) +(-|[0-9]+)\t(.+)$/s.exec(
      record
    )
    if (!match) {
      throw new Error('plugin Git trees cannot contain symlinks, submodules or unknown entries')
    }
    const [, mode, type, object, sizeText, path] = match
    validatePath(path)
    const identity = portablePathIdentity(path)
    if (portablePaths.has(identity)) {
      throw new Error(`colliding plugin paths: ${path}`)
    }
    portablePaths.add(identity)
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
    if (parent !== null && kinds.get(parent) !== 'tree') {
      throw new Error(`missing directory in plugin Git tree: ${path}`)
    }
    let entry: PluginGitTreeEntry
    if (mode === '040000' && type === 'tree' && sizeText === '-') {
      entry = { kind: 'tree', path }
    } else if (mode !== '040000' && type === 'blob' && sizeText !== '-') {
      const size = Number(sizeText)
      totalBytes += size
      if (!Number.isSafeInteger(size) || totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        throw new Error(`plugin exceeds the ${MAX_PLUGIN_TOTAL_BYTES}-byte limit`)
      }
      entry = { kind: 'blob', path, object, size, executable: mode === '100755' }
    } else {
      throw new Error('invalid plugin Git entry mode, type or size')
    }
    kinds.set(path, entry.kind)
    entries.push(entry)
  }
  return entries
}

/** Splits `git cat-file --batch` output, requesting each distinct blob once in entry order. */
export function readPluginGitBatchBlobs(
  bytes: Buffer,
  entries: readonly PluginGitTreeEntry[]
): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>()
  let offset = 0
  for (const entry of entries) {
    if (entry.kind !== 'blob' || blobs.has(entry.object)) {
      continue
    }
    const end = bytes.indexOf(10, offset)
    if (end < offset || end - offset > 128) {
      throw new Error('missing plugin Git blob header')
    }
    if (bytes.subarray(offset, end).toString('ascii') !== `${entry.object} blob ${entry.size}`) {
      throw new Error('plugin Git blob identity or size changed')
    }
    const start = end + 1
    const next = start + entry.size
    if (next >= bytes.length || bytes[next] !== 10) {
      throw new Error('truncated plugin Git blob')
    }
    blobs.set(entry.object, bytes.subarray(start, next))
    offset = next + 1
  }
  if (offset !== bytes.length) {
    throw new Error('unexpected trailing plugin Git blob data')
  }
  return blobs
}

/** Writes a commit's exact blobs without `checkout`, so no filter, hook or attribute runs. */
export async function materializePluginGitTree(input: {
  repository: string
  commit: string
  destination: string
}): Promise<void> {
  const options = { cwd: input.repository, timeout: PLUGIN_GIT_TREE_TIMEOUT_MS }
  const metadata = await gitExecFileAsyncBuffer(pluginGitTreeArgs(input.commit), {
    ...options,
    maxBuffer: TREE_METADATA_MAX_BYTES
  })
  const entries = parsePluginGitTree(metadata.stdout)
  const objects = [
    ...new Set(entries.flatMap((entry) => (entry.kind === 'blob' ? [entry.object] : [])))
  ]
  const data = objects.length
    ? await gitExecFileAsyncBuffer(['cat-file', '--batch'], {
        ...options,
        maxBuffer: MAX_PLUGIN_TOTAL_BYTES + MAX_PLUGIN_FILES * 128,
        stdin: `${objects.join('\n')}\n`
      })
    : { stdout: Buffer.alloc(0) }
  const blobs = readPluginGitBatchBlobs(data.stdout, entries)
  for (const entry of entries) {
    const target = join(input.destination, ...entry.path.split('/'))
    if (entry.kind === 'tree') {
      await mkdir(target)
      continue
    }
    const bytes = blobs.get(entry.object)
    if (!bytes || bytes.length !== entry.size) {
      throw new Error('missing plugin Git blob')
    }
    await writeFile(target, bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 })
  }
}
