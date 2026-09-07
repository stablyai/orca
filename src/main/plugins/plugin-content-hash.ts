import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pluginPathSegmentError } from '../../shared/plugins/plugin-path-safety'

/**
 * Deterministic hash of a plugin's file tree. The hash names the immutable
 * install directory (`<userData>/plugins/<publisher>.<id>/<hash>/`), so two
 * installs of identical content share a name and a mutated install is
 * detectable. Hashes relative paths + file bytes in sorted order; symlinks
 * are refused outright (installed trees must be self-contained).
 */

const MAX_PLUGIN_FILES = 2_000
const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024

type PluginFile = { path: string; size: number }

export type PluginTreeHashResult =
  | { ok: true; hash: string; fileCount: number; totalBytes: number }
  | { ok: false; error: string }

async function collectFiles(
  root: string,
  dir: string,
  files: PluginFile[],
  counters: { entries: number; bytes: number }
): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  // Why: localeCompare ordering varies with host locale/ICU data; content
  // addresses must sort identically on macOS, Linux, and Windows.
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (dir === root && entry.name === '.git') {
      continue
    }
    const segmentError = pluginPathSegmentError(entry.name)
    if (segmentError) {
      return `unsafe plugin path segment "${entry.name}": ${segmentError}`
    }
    const full = join(dir, entry.name)
    const stat = await lstat(full)
    counters.entries += 1
    if (counters.entries > MAX_PLUGIN_FILES) {
      return `plugin exceeds the ${MAX_PLUGIN_FILES}-entry limit`
    }
    if (stat.isSymbolicLink()) {
      return `symlink not allowed in plugin content: ${relative(root, full)}`
    }
    if (stat.isDirectory()) {
      const error = await collectFiles(root, full, files, counters)
      if (error) {
        return error
      }
    } else if (stat.isFile()) {
      counters.bytes += stat.size
      if (counters.bytes > MAX_PLUGIN_TOTAL_BYTES) {
        return `plugin exceeds the ${MAX_PLUGIN_TOTAL_BYTES}-byte limit`
      }
      files.push({ path: full, size: stat.size })
    } else {
      return `unsupported plugin entry type: ${relative(root, full)}`
    }
  }
  return null
}

async function hashFileBounded(
  hash: ReturnType<typeof createHash>,
  file: PluginFile
): Promise<number> {
  let bytesRead = 0
  for await (const chunk of createReadStream(file.path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytesRead += bytes.byteLength
    if (bytesRead > file.size || bytesRead > MAX_PLUGIN_TOTAL_BYTES) {
      throw new Error(`plugin file changed while hashing: ${file.path}`)
    }
    hash.update(bytes)
  }
  if (bytesRead !== file.size) {
    throw new Error(`plugin file changed while hashing: ${file.path}`)
  }
  return bytesRead
}

export async function hashPluginTree(root: string): Promise<PluginTreeHashResult> {
  const files: PluginFile[] = []
  try {
    const counters = { entries: 0, bytes: 0 }
    const error = await collectFiles(root, root, files, counters)
    if (error) {
      return { ok: false, error }
    }
    const hash = createHash('sha256')
    // Why: every record is length-framed so path/content delimiters inside a
    // plugin file cannot make two different trees share one hash preimage.
    hash.update('orca-plugin-tree-v1\0')
    let totalBytes = 0
    for (const file of files) {
      totalBytes += file.size
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        return { ok: false, error: `plugin exceeds the ${MAX_PLUGIN_TOTAL_BYTES}-byte limit` }
      }
      // Normalize separators so the same tree hashes identically on Windows.
      const rel = relative(root, file.path).replaceAll('\\', '/')
      hashLength(hash, Buffer.byteLength(rel, 'utf8'))
      hash.update(rel, 'utf8')
      hashLength(hash, file.size)
      await hashFileBounded(hash, file)
    }
    // Hex (not base64) because the hash becomes a directory name.
    return {
      ok: true,
      hash: hash.digest('hex'),
      fileCount: files.length,
      totalBytes
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function hashLength(hash: ReturnType<typeof createHash>, length: number): void {
  const framedLength = Buffer.allocUnsafe(8)
  framedLength.writeBigUInt64BE(BigInt(length))
  hash.update(framedLength)
}
