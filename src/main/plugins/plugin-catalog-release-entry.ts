import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { parseGitRepositoryIdentity } from '../../shared/plugins/catalog/plugin-marketplace'
import { pluginCatalogReleaseEntry } from '../../shared/plugins/catalog/plugin-catalog-release'
import { catalogImagesFromManifest } from '../../shared/plugins/images/plugin-manifest-catalog-images'
import { isPluginRepositoryPath } from '../../shared/plugins/installation/plugin-path-safety'
import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest
} from '../../shared/plugins/manifest/plugin-manifest'
import { materializePluginGitTree, type PluginGitBytesRunner } from './installation/plugin-git-tree'
import { hashPluginTree } from './plugin-content-hash'

const GIT_QUERY_TIMEOUT_MS = 30_000
const GIT_QUERY_MAX_BYTES = 1024 * 1024

type PluginCatalogRelease = NonNullable<ReturnType<typeof pluginCatalogReleaseEntry>>

export type PluginCatalogReleaseReport = {
  /** The `releases` entry for HEAD; absent when HEAD is not an installable catalog release. */
  entry?: PluginCatalogRelease
  /** The plugin's directory in its repository, for the catalog `source.path`; absent at the root. */
  sourcePath?: string
  /** Why there is no entry, or that uncommitted changes are left out of it. */
  note?: string
  /** The `origin` owner Orca lists the plugin under differs from the declared publisher. */
  ownerWarning?: string
}

const runGitBytes: PluginGitBytesRunner = async (args, options) => {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: options.cwd,
    // Why: `status` would otherwise take the index lock the author's own Git may hold.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxBytes,
    killOnOutputLimit: true,
    captureStdoutAsBytes: true,
    ...(options.stdin !== undefined ? { input: options.stdin } : {})
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const detail = result.timedOut
      ? 'timed out'
      : result.outputTruncated
        ? 'output too large'
        : result.stderr.trim().split('\n')[0] || `exit ${result.code}`
    throw new Error(`git ${args[0]} failed: ${detail}`)
  }
  return result.stdoutBytes ?? Buffer.alloc(0)
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const bytes = await runGitBytes(args, {
    cwd,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    maxBytes: GIT_QUERY_MAX_BYTES
  })
  return bytes.toString('utf8').trim()
}

async function readTreeFile(file: string, maxBytes: number): Promise<Buffer | null> {
  const info = await stat(file).catch(() => null)
  return info?.isFile() && info.size <= maxBytes ? readFile(file) : null
}

async function committedReleaseEntry(
  pluginDir: string,
  commit: string,
  sourcePath: string | undefined
): Promise<{ entry: PluginCatalogRelease } | { note: string }> {
  const tree = await mkdtemp(join(tmpdir(), 'orca-plugin-release-'))
  try {
    try {
      await materializePluginGitTree({
        repository: pluginDir,
        commit,
        destination: tree,
        ...(sourcePath ? { path: sourcePath } : {}),
        git: runGitBytes
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { note: `no catalog release entry: HEAD has no installable plugin here (${detail})` }
    }
    const hashed = await hashPluginTree(tree)
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(await readFile(join(tree, PLUGIN_MANIFEST_FILENAME), 'utf8'))
    } catch {
      return { note: `no catalog release entry: HEAD has no valid ${PLUGIN_MANIFEST_FILENAME}` }
    }
    const parsed = parsePluginManifest(rawManifest)
    const release =
      hashed.ok && parsed.ok
        ? pluginCatalogReleaseEntry(parsed.manifest, { commit, contentHash: hashed.hash })
        : null
    // Why here: a new release entry must carry the manifest's images, or listings lose their covers.
    const images = release
      ? await catalogImagesFromManifest({
          manifest: rawManifest,
          prefix: sourcePath,
          read: (repositoryPath, maxBytes) =>
            readTreeFile(
              join(
                tree,
                ...repositoryPath.slice(sourcePath ? sourcePath.length + 1 : 0).split('/')
              ),
              maxBytes
            ),
          sha256: (bytes) => createHash('sha256').update(bytes).digest('hex')
        })
      : null
    if (!release) {
      const reason = !hashed.ok
        ? hashed.error
        : !parsed.ok
          ? parsed.error
          : 'catalogs need manifest format 2'
      return { note: `no catalog release entry: committed plugin is not installable (${reason})` }
    }
    return { entry: images ? { ...release, images } : release }
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
}

// Why a warning: Orca derives the publisher from the owner; older Orca refuses a declared one that differs.
async function publisherOwnerWarning(pluginDir: string): Promise<string | undefined> {
  const remote = await gitText(pluginDir, ['remote', 'get-url', 'origin']).catch(() => '')
  const owner = parseGitRepositoryIdentity(remote)?.owner?.toLowerCase()
  const manifest: unknown = await readFile(join(pluginDir, PLUGIN_MANIFEST_FILENAME), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)
  const publisher =
    manifest && typeof manifest === 'object' && 'publisher' in manifest
      ? manifest.publisher
      : undefined
  return owner && typeof publisher === 'string' && owner !== publisher.toLowerCase()
    ? `Orca lists this plugin under the repository owner "${owner}", and older Orca refuses it because publisher is "${publisher}"; remove publisher or set it to "${owner}"`
    : undefined
}

/** The catalog release entry for the committed HEAD of the repository holding `pluginDir`,
 *  hashed from the commit's blobs exactly as install does. Offline; never runs plugin code. */
export async function pluginCatalogReleaseForHead(
  pluginDir: string
): Promise<PluginCatalogReleaseReport> {
  // Why --show-prefix: it is the plugin's directory in the repository, always with `/`.
  const prefix = await gitText(pluginDir, ['rev-parse', '--show-prefix']).catch(() => null)
  if (prefix === null) {
    return { note: 'no catalog release entry: the plugin is not in a Git repository' }
  }
  const sourcePath = prefix.replace(/\/$/, '') || undefined
  if (sourcePath !== undefined && !isPluginRepositoryPath(sourcePath)) {
    return { note: `no catalog release entry: ${sourcePath} cannot be a catalog source path` }
  }
  const ownerWarning = await publisherOwnerWarning(pluginDir)
  const withWarning = ownerWarning ? { ownerWarning } : {}
  const commit = await gitText(pluginDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    .then((sha) => (/^[0-9a-f]{40}$/.test(sha) ? sha : null))
    .catch(() => null)
  if (commit === null) {
    return {
      ...(sourcePath ? { sourcePath } : {}),
      note: 'no catalog release entry: HEAD is not a SHA-1 commit; commit the plugin first',
      ...withWarning
    }
  }
  const dirty = (await gitText(pluginDir, ['status', '--porcelain', '--', '.'])) !== ''
  const result = await committedReleaseEntry(pluginDir, commit, sourcePath)
  return {
    ...result,
    ...(sourcePath ? { sourcePath } : {}),
    ...(dirty && 'entry' in result
      ? { note: 'uncommitted changes are not in this release; commit them first' }
      : {}),
    ...withWarning
  }
}
