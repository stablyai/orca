const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')

const MAX_PLUGIN_FILES = 2_000
const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024

function hashLength(hash, length) {
  const framedLength = Buffer.allocUnsafe(8)
  framedLength.writeBigUInt64BE(BigInt(length))
  hash.update(framedLength)
}

function hashPackagedPluginTree(root) {
  const files = []
  let entriesVisited = 0
  let totalBytes = 0
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )
    for (const entry of entries) {
      if (directory === root && entry.name === '.git') {
        continue
      }
      const entryPath = join(directory, entry.name)
      const metadata = lstatSync(entryPath)
      entriesVisited += 1
      if (entriesVisited > MAX_PLUGIN_FILES) {
        throw new Error(`plugin exceeds the ${MAX_PLUGIN_FILES}-entry limit`)
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(`packaged plugin contains a symlink: ${relative(root, entryPath)}`)
      }
      if (metadata.isDirectory()) {
        visit(entryPath)
      } else if (metadata.isFile()) {
        totalBytes += metadata.size
        if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
          throw new Error(`plugin exceeds the ${MAX_PLUGIN_TOTAL_BYTES}-byte limit`)
        }
        files.push({ path: entryPath, size: metadata.size })
      } else {
        throw new Error(`packaged plugin contains an unsupported entry: ${entryPath}`)
      }
    }
  }
  visit(root)
  const hash = createHash('sha256').update('orca-plugin-tree-v1\0')
  for (const file of files) {
    const relativePath = relative(root, file.path).replaceAll('\\', '/')
    hashLength(hash, Buffer.byteLength(relativePath, 'utf8'))
    hash.update(relativePath, 'utf8')
    hashLength(hash, file.size)
    hash.update(readFileSync(file.path))
  }
  return hash.digest('hex')
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `[verify-packaged-plugin-resources] invalid ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function verifyPackagedPluginResources(resourcesDir) {
  const launchRoot = join(resourcesDir, 'plugins', 'launch')
  if (!statSync(launchRoot).isDirectory()) {
    throw new Error(`[verify-packaged-plugin-resources] missing launch directory at ${launchRoot}`)
  }
  const index = readJsonFile(join(launchRoot, 'bundled-plugins.json'), 'bundled plugin index')
  readJsonFile(join(launchRoot, 'orca-marketplace.json'), 'marketplace index')
  if (index?.version !== 1 || !Array.isArray(index.plugins) || index.plugins.length === 0) {
    throw new Error('[verify-packaged-plugin-resources] bundled plugin index is empty or invalid')
  }
  const resolvedRoot = resolve(launchRoot)
  for (const entry of index.plugins) {
    if (
      typeof entry?.pluginKey !== 'string' ||
      typeof entry.path !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.contentHash)
    ) {
      throw new Error('[verify-packaged-plugin-resources] bundled plugin entry is invalid')
    }
    const pluginRoot = resolve(launchRoot, entry.path)
    const fromRoot = relative(resolvedRoot, pluginRoot)
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('[verify-packaged-plugin-resources] bundled plugin path escapes launch root')
    }
    const manifest = readJsonFile(join(pluginRoot, 'orca-plugin.json'), 'plugin manifest')
    if (`${manifest.publisher}.${manifest.id}` !== entry.pluginKey) {
      throw new Error(
        `[verify-packaged-plugin-resources] manifest identity does not match ${entry.pluginKey}`
      )
    }
    if (hashPackagedPluginTree(pluginRoot) !== entry.contentHash) {
      throw new Error(
        `[verify-packaged-plugin-resources] packaged bytes do not match ${entry.pluginKey}`
      )
    }
  }
  console.log(
    `[verify-packaged-plugin-resources] OK — verified ${index.plugins.length} bundled plugin(s)`
  )
}

module.exports = { verifyPackagedPluginResources }
