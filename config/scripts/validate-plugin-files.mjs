// Strict check of plugin manifests and catalogs, for authors and catalog CI.
// Usage: node config/scripts/validate-plugin-files.mjs <plugin dir | orca-plugin.json | orca-catalog.json>...
// For a plugin repository root it also prints the catalog release entry for the committed HEAD.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadPluginSchemaModule } from './plugin-schema-module-loader.mjs'

const { validatePluginFile } = loadPluginSchemaModule('plugin-file-validation.ts')
const { parsePluginManifest } = loadPluginSchemaModule('manifest/plugin-manifest.ts')
const { pluginCatalogReleaseEntry } = loadPluginSchemaModule('catalog/plugin-catalog-release.ts')
// Why the install code itself: the printed contentHash must be what Orca computes at install.
const { materializePluginGitTree } = loadPluginSchemaModule(
  '../../main/plugins/installation/plugin-git-tree.ts'
)
const { hashPluginTree } = loadPluginSchemaModule('../../main/plugins/plugin-content-hash.ts')
const { gitExecFileAsync } = loadPluginSchemaModule('../../main/git/runner.ts')

async function git(cwd, args) {
  return (await gitExecFileAsync(args, { cwd })).stdout.trim()
}

/** Release entry for HEAD of the repository at `pluginDir`; a note when that is not possible. */
async function catalogReleaseEntry(pluginDir) {
  const top = await git(pluginDir, ['rev-parse', '--show-toplevel']).catch(() => null)
  if (!top || realpathSync(top) !== realpathSync(pluginDir)) {
    return { note: 'no catalog release entry: run this on the root of the plugin repository' }
  }
  const commit = await git(pluginDir, ['rev-parse', 'HEAD'])
  const dirty = (await git(pluginDir, ['status', '--porcelain'])) !== ''
  const tree = mkdtempSync(path.join(tmpdir(), 'orca-plugin-release-'))
  try {
    await materializePluginGitTree({ repository: pluginDir, commit, destination: tree })
    const hashed = await hashPluginTree(tree)
    const parsed = parsePluginManifest(
      JSON.parse(readFileSync(path.join(tree, 'orca-plugin.json'), 'utf8'))
    )
    const entry =
      hashed.ok && parsed.ok
        ? pluginCatalogReleaseEntry(parsed.manifest, { commit, contentHash: hashed.hash })
        : null
    if (!entry) {
      return {
        note: `no catalog release entry: committed plugin is not installable (${hashed.ok ? (parsed.ok ? 'catalogs need manifest format 2' : parsed.error) : hashed.error})`
      }
    }
    return {
      entry,
      ...(dirty ? { note: 'uncommitted changes are not in this release; commit them first' } : {})
    }
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
}
const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error(
    'usage: validate-plugin-files <plugin dir | orca-plugin.json | orca-catalog.json>...'
  )
  process.exit(2)
}
let failed = false
for (const target of targets) {
  const files = statSync(target).isDirectory()
    ? ['orca-plugin.json', 'orca-catalog.json']
        .map((name) => path.join(target, name))
        .filter((file) => existsSync(file))
    : [target]
  if (files.length === 0) {
    console.error(`${target}: no orca-plugin.json or orca-catalog.json`)
    failed = true
  }
  let manifestOk = false
  for (const file of files) {
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.error(`${file}: invalid JSON: ${error.message}`)
      failed = true
      continue
    }
    const root = path.dirname(file)
    // Why contained: an image path must stay inside the catalog repository.
    const readCatalogFile = (relative) => {
      const target = path.resolve(root, relative)
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !existsSync(target)) {
        return null
      }
      const bytes = readFileSync(target)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const errors = validatePluginFile(path.basename(file), raw, readCatalogFile)
    for (const error of errors) {
      console.error(`${file}: ${error}`)
    }
    failed ||= errors.length > 0
    if (errors.length === 0) {
      console.log(`${file}: ok`)
      manifestOk ||= path.basename(file) === 'orca-plugin.json'
    }
  }
  if (manifestOk && statSync(target).isDirectory()) {
    const { entry, note } = await catalogReleaseEntry(target)
    if (entry) {
      console.log(
        `\nCatalog release entry for HEAD (newest first in "releases"):\n${JSON.stringify(entry, null, 2)}`
      )
    }
    if (note) {
      console.log(`${target}: ${note}`)
    }
  }
}
process.exit(failed ? 1 : 0)
