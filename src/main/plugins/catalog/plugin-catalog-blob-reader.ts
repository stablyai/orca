import { offlineGitEnv } from '../../git/command-runner/git-environment/git-process-env'
import { PLUGIN_IMAGE_RULES } from '../../../shared/plugins/images/plugin-image-fields'
import { pluginRelativePathSchema } from '../../../shared/plugins/manifest/plugin-manifest-fields'
import { gitExecFileAsyncBuffer } from '../../git/command-runner/git-exec-file'
import { readPluginGitBatchBlobs, type PluginGitTreeEntry } from '../installation/plugin-git-tree'
import { createCatalogBufferMemo, type CatalogBufferMemo } from './plugin-catalog-image-extraction'

export const MARKETPLACE_GIT_TIMEOUT_MS = 120_000
const CATALOG_BLOB_CACHE_MAX_BYTES = 96 * 1024 * 1024
const CATALOG_BLOB_ROUND_MAX_BYTES = 32 * 1024 * 1024

export type CatalogLoadState = {
  files: Map<string, CatalogFile>
  listed: Map<string, ListedBlob>
  /** Paths whose Git listing or read failed; batched passes treat them as absent. */
  failed: Set<string>
  memo: CatalogBufferMemo
  readOptions?: { timeout: number; env?: NodeJS.ProcessEnv }
}

/** A regular file's size and, when it fit the largest requested limit, its bytes; null when absent. */
type CatalogFile = { size: number; bytes: Buffer | null } | null
type ListedBlob = { object: string; size: number } | null

// Keep each ls-tree argv well under the Windows command-line limit.
const LS_TREE_PATH_CHUNK_CHARS = 16 * 1024

/** Loads files from the catalog commit, refusing to read any larger than its requested limit.
 *  Paths past the round's byte cap stay unlisted and unloaded so the next extraction pass asks again
 *  with its remaining image budget. False once retaining another file would pass the retained cap. */
export async function loadCatalogFiles(
  repository: string,
  commit: string,
  requests: ReadonlyMap<string, number>,
  { files, listed, failed, readOptions = { timeout: MARKETPLACE_GIT_TIMEOUT_MS } }: CatalogLoadState
): Promise<boolean> {
  let retainedBytes = 0
  for (const file of files.values()) {
    retainedBytes += file?.bytes?.byteLength ?? 0
  }
  const reads: Extract<PluginGitTreeEntry, { kind: 'blob' }>[] = []
  let roundBytes = 0
  // List in request order only until the round fills, so paths past it wait for a later pass.
  for (const chunk of chunkByLength([...requests.keys()], LS_TREE_PATH_CHUNK_CHARS)) {
    const unlisted = chunk.filter((path) => !listed.has(path))
    if (unlisted.length > 0) {
      await listCatalogPaths(repository, commit, unlisted, listed, failed, readOptions)
    }
    for (const path of chunk) {
      const found = listed.get(path)
      if (found && found.size > requests.get(path)!) {
        files.set(path, { size: found.size, bytes: null })
        continue
      }
      if (!found) {
        files.set(path, null)
        continue
      }
      if (retainedBytes + found.size > CATALOG_BLOB_CACHE_MAX_BYTES) {
        // Sequential reads keep only what extraction holds, so a catalog this large still loads.
        return false
      }
      if (reads.length > 0 && roundBytes + found.size > CATALOG_BLOB_ROUND_MAX_BYTES) {
        return readCatalogRound(repository, reads, files, failed, readOptions)
      }
      roundBytes += found.size
      retainedBytes += found.size
      reads.push({ kind: 'blob', path, object: found.object, size: found.size, executable: false })
    }
  }
  return readCatalogRound(repository, reads, files, failed, readOptions)
}

async function listCatalogPaths(
  repository: string,
  commit: string,
  paths: string[],
  listed: Map<string, ListedBlob>,
  failed: Set<string>,
  readOptions: { timeout: number; env?: NodeJS.ProcessEnv }
): Promise<void> {
  try {
    const listing = await gitExecFileAsyncBuffer(['ls-tree', '-l', '-z', commit, '--', ...paths], {
      cwd: repository,
      ...readOptions,
      maxBuffer: paths.length * 4 * 1024
    })
    const entries = new Map<string, { object: string; size: number }>()
    for (const record of listing.stdout.toString('utf8').split('\0')) {
      const match = /^100(?:644|755) blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/s.exec(record)
      if (match) {
        entries.set(match[3]!, { object: match[1]!, size: Number(match[2]) })
      }
    }
    for (const path of paths) {
      listed.set(path, entries.get(gitTreePath(path)) ?? null)
    }
  } catch {
    for (const path of paths) {
      failed.add(path)
    }
  }
}

async function readCatalogRound(
  repository: string,
  reads: Extract<PluginGitTreeEntry, { kind: 'blob' }>[],
  files: Map<string, CatalogFile>,
  failed: Set<string>,
  readOptions: { timeout: number; env?: NodeJS.ProcessEnv }
): Promise<true> {
  const options = { cwd: repository, ...readOptions }
  if (reads.length === 0) {
    return true
  }
  try {
    const objects = [...new Map(reads.map((read) => [read.object, read])).values()]
    const batch = await gitExecFileAsyncBuffer(['cat-file', '--batch'], {
      ...options,
      stdin: objects.map((read) => `${read.object}\n`).join(''),
      maxBuffer: objects.reduce((total, read) => total + read.size + 128, 0)
    })
    const contents = readPluginGitBatchBlobs(batch.stdout, objects)
    for (const read of reads) {
      files.set(read.path, { size: read.size, bytes: contents.get(read.object) ?? null })
    }
  } catch {
    for (const read of reads) {
      files.set(read.path, null)
      failed.add(read.path)
    }
  }
  return true
}

function chunkByLength(paths: string[], maxChars: number): string[][] {
  const chunks: string[][] = []
  let chars = maxChars
  for (const path of paths) {
    if (chars + path.length > maxChars) {
      chunks.push([])
      chars = 0
    }
    chunks.at(-1)!.push(path)
    chars += path.length + 1
  }
  return chunks
}

/** Git for Windows accepts either separator in a pathspec but always lists `/`. */
function gitTreePath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/** Shares the catalog's bounded Git batch reader, with transport disabled on cache misses. */
export async function readCatalogImageBlobs(
  repository: string,
  commit: string,
  paths: ReadonlyMap<string, number>
): Promise<Map<string, Buffer>> {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return new Map()
  }
  const requests = new Map(
    [...paths].filter(
      ([path, maxBytes]) =>
        pluginRelativePathSchema.safeParse(path).success &&
        maxBytes > 0 &&
        maxBytes <= PLUGIN_IMAGE_RULES.screenshot.maxBytes
    )
  )
  const state: CatalogLoadState = {
    files: new Map(),
    listed: new Map(),
    failed: new Set(),
    memo: createCatalogBufferMemo(),
    readOptions: {
      timeout: 10_000,
      env: offlineGitEnv()
    }
  }
  await loadCatalogFiles(repository, commit, requests, state)
  return new Map(
    [...state.files].flatMap(([path, file]) => (file?.bytes ? [[path, file.bytes]] : []))
  )
}
