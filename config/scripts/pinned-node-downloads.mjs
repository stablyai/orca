// Hash-verified downloads of the pinned Node's build inputs (headers, node.lib) and executable.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  NODE_RUNTIME_PIN,
  isWindowsServerTarget,
  nodeRuntimeAsset,
  nodeRuntimeExecutablePath,
  nodeRuntimeHeadersUrl,
  nodeRuntimeReleaseUrl
} from '../../src/shared/node-runtime-pin.ts'
import { download, extract, sha256File } from './update-node-runtime-pin.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

export function pinnedNodeCacheDir(env = process.env) {
  return env.ORCA_NODE_RUNTIME_CACHE_DIR || join(ROOT, 'out', 'node-runtime-cache')
}

/** Reuses a cached file only when it still hashes to the pin; anything else is re-fetched. */
export async function fetchPinnedFile({ url, destination, sha256 }) {
  if (existsSync(destination) && (await sha256File(destination)) === sha256) {
    return destination
  }
  mkdirSync(join(destination, '..'), { recursive: true })
  const partial = `${destination}.partial-${process.pid}`
  await download(url, partial)
  const actual = await sha256File(partial)
  if (actual !== sha256) {
    rmSync(partial, { force: true })
    throw new Error(`${url} hashed ${actual}, but the Node runtime pin expects ${sha256}`)
  }
  rmSync(destination, { force: true })
  copyFileSync(partial, destination)
  rmSync(partial, { force: true })
  return destination
}

/**
 * A node-gyp `--nodedir` for `target`, built from the pinned headers tarball.
 *
 * Why per target: on Windows node-gyp links `<nodedir>/Release/node.lib`, which differs by
 * arch and is not in the headers tarball.
 */
export async function preparePinnedNodeDir({ target, workDir, cacheDir = pinnedNodeCacheDir() }) {
  const { version, headers } = NODE_RUNTIME_PIN
  const tarball = await fetchPinnedFile({
    url: nodeRuntimeHeadersUrl(),
    destination: join(cacheDir, headers.file),
    sha256: headers.sha256
  })
  rmSync(workDir, { recursive: true, force: true })
  extract(tarball, workDir, `node-v${version}/include`)
  const nodeDir = join(workDir, `node-v${version}`)
  if (isWindowsServerTarget(target)) {
    const lib = NODE_RUNTIME_PIN.windowsImportLibs[target]
    const cached = await fetchPinnedFile({
      url: nodeRuntimeReleaseUrl('official', lib.file, version),
      destination: join(cacheDir, `node-v${version}-${lib.file.replace('/', '-')}`),
      sha256: lib.sha256
    })
    mkdirSync(join(nodeDir, 'Release'), { recursive: true })
    copyFileSync(cached, join(nodeDir, 'Release', 'node.lib'))
  }
  return nodeDir
}

/** The pinned `node` for a default or compat `target`, verified against both hashes. */
export async function ensurePinnedNodeExecutable({ target, cacheDir = pinnedNodeCacheDir() }) {
  const asset = nodeRuntimeAsset(target)
  if (!asset) {
    throw new Error(`The Node runtime pin has no asset for ${target}`)
  }
  const member = nodeRuntimeExecutablePath(target, asset.archive)
  const executable = join(cacheDir, member)
  if (existsSync(executable) && (await sha256File(executable)) === asset.executableSha256) {
    return executable
  }
  const archive = await fetchPinnedFile({
    url: nodeRuntimeReleaseUrl(asset.source, asset.archive),
    destination: join(cacheDir, asset.archive),
    sha256: asset.archiveSha256
  })
  extract(archive, cacheDir, member)
  const actual = await sha256File(executable)
  if (actual !== asset.executableSha256) {
    throw new Error(`${member} hashed ${actual}, but the pin expects ${asset.executableSha256}`)
  }
  if (process.platform !== 'win32') {
    chmodSync(executable, 0o755)
  }
  return executable
}
