// Strict check of plugin manifests and catalogs, for authors and catalog CI.
// Usage: node config/scripts/validate-plugin-files.mjs <plugin dir | orca-plugin.json | orca-catalog.json>...
// For a plugin directory in a Git repository it also prints the catalog release entry for the
// committed HEAD, with the `source.path` to list when the plugin is not the repository root.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadPluginSchemaModule } from './plugin-schema-module-loader.mjs'

const { validatePluginFile } = loadPluginSchemaModule('installation/plugin-file-validation.ts')
const { parsePluginManifest } = loadPluginSchemaModule('manifest/plugin-manifest.ts')
const { pluginCatalogReleaseEntry } = loadPluginSchemaModule('catalog/plugin-catalog-release.ts')
// Why the install code itself: the printed contentHash must be what Orca computes at install.
const { materializePluginGitTree } = loadPluginSchemaModule(
  '../../main/plugins/installation/plugin-git-tree.ts'
)
const { hashPluginTree } = loadPluginSchemaModule('../../main/plugins/plugin-content-hash.ts')
const { gitExecFileAsync } = loadPluginSchemaModule('../../main/git/runner.ts')
const { formatPluginSchemaIssues } = loadPluginSchemaModule('manifest/plugin-schema-issues.ts')
const { isPluginRepositoryPath } = loadPluginSchemaModule('installation/plugin-path-safety.ts')
const { parseGitRepositoryIdentity } = loadPluginSchemaModule('catalog/plugin-marketplace.ts')
const { catalogImagesFromManifest } = loadPluginSchemaModule(
  'images/plugin-manifest-catalog-images.ts'
)
const ARTIFACT_PARSERS = {
  themes: loadPluginSchemaModule('artifacts/plugin-theme-artifact.ts').parsePluginAppThemeArtifact,
  terminalThemes: loadPluginSchemaModule('artifacts/plugin-terminal-theme-artifact.ts')
    .parsePluginTerminalThemeArtifact,
  iconThemes: loadPluginSchemaModule('artifacts/plugin-icon-theme-artifact.ts')
    .parsePluginIconThemeArtifact
}
const { parsePluginLanguagePackArtifact } = loadPluginSchemaModule(
  'artifacts/plugin-language-pack-artifact.ts'
)
const { parsePluginLanguageConfiguration } = loadPluginSchemaModule(
  'artifacts/plugin-syntax-artifact.ts'
)

// Why strict here: Orca skips unknown theme tokens and icon slots at runtime, so authors only
// learn about a typo from this check.
function artifactErrors(pluginDir, manifest) {
  return Object.entries(ARTIFACT_PARSERS).flatMap(([point, parse]) =>
    manifest.contributes[point].flatMap((contribution) => {
      let text = ''
      try {
        text = readFileSync(path.join(pluginDir, ...contribution.path.split('/')), 'utf8')
        parse(text, 'strict')
        return []
      } catch (error) {
        const detail = error.issues
          ? formatPluginSchemaIssues(error.issues, JSON.parse(text))
          : error.message
        return [`contributes.${point} "${contribution.id}" (${contribution.path}): ${detail}`]
      }
    })
  )
}

// Why: Orca drops protected security copy from a pack at load, which authors would never notice.
function languagePackErrors(pluginDir, manifest) {
  return manifest.contributes.languagePacks.flatMap((pack) => {
    const file = path.join(pluginDir, ...pack.path.split('/'))
    const parsed = existsSync(file)
      ? parsePluginLanguagePackArtifact(readFileSync(file, 'utf8'), 'strict')
      : { ok: false, error: 'file not found' }
    return parsed.ok
      ? []
      : [`contributes.languagePacks "${pack.locale}" (${pack.path}): ${parsed.error}`]
  })
}

// Why: Orca drops an unsafe auto-closing pair or comment marker at load instead of failing.
function syntaxConfigurationErrors(pluginDir, manifest) {
  return manifest.contributes.syntaxes.flatMap((syntax) => {
    if (!syntax.configuration) {
      return []
    }
    let text = ''
    try {
      text = readFileSync(path.join(pluginDir, ...syntax.configuration.split('/')), 'utf8')
      parsePluginLanguageConfiguration(text, 'strict')
      return []
    } catch (error) {
      const detail = error.issues
        ? formatPluginSchemaIssues(error.issues, JSON.parse(text))
        : error.message
      return [`contributes.syntaxes "${syntax.id}" (${syntax.configuration}): ${detail}`]
    }
  })
}

async function git(cwd, args) {
  return (await gitExecFileAsync(args, { cwd })).stdout.trim()
}

/** Release entry for HEAD of the repository holding `pluginDir`; a note when that is not possible. */
async function catalogReleaseEntry(pluginDir) {
  // Why --show-prefix: it is the plugin's directory in the repository, always with `/`.
  const prefix = await git(pluginDir, ['rev-parse', '--show-prefix']).catch(() => null)
  if (prefix === null) {
    return { note: 'no catalog release entry: the plugin is not in a Git repository' }
  }
  const sourcePath = prefix.replace(/\/$/, '') || undefined
  if (sourcePath !== undefined && !isPluginRepositoryPath(sourcePath)) {
    return { note: `no catalog release entry: ${sourcePath} cannot be a catalog source path` }
  }
  const commit = await git(pluginDir, ['rev-parse', 'HEAD'])
  const dirty = (await git(pluginDir, ['status', '--porcelain', '--', '.'])) !== ''
  const tree = mkdtempSync(path.join(tmpdir(), 'orca-plugin-release-'))
  try {
    await materializePluginGitTree({
      repository: pluginDir,
      commit,
      destination: tree,
      ...(sourcePath ? { path: sourcePath } : {})
    })
    const hashed = await hashPluginTree(tree)
    const rawManifest = JSON.parse(readFileSync(path.join(tree, 'orca-plugin.json'), 'utf8'))
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
          read: async (repositoryPath, maxBytes) => {
            const file = path.join(
              tree,
              repositoryPath.slice(sourcePath ? sourcePath.length + 1 : 0)
            )
            return existsSync(file) && statSync(file).size <= maxBytes ? readFileSync(file) : null
          },
          sha256: (bytes) => createHash('sha256').update(bytes).digest('hex')
        })
      : null
    const entry = release && images ? { ...release, images } : release
    if (!entry) {
      return {
        note: `no catalog release entry: committed plugin is not installable (${hashed.ok ? (parsed.ok ? 'catalogs need manifest format 2' : parsed.error) : hashed.error})`
      }
    }
    return {
      entry,
      sourcePath,
      ...(dirty ? { note: 'uncommitted changes are not in this release; commit them first' } : {})
    }
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
}
// Why a warning: only the official and community catalogs require it; a private catalog may not.
async function publisherOwnerWarning(pluginDir) {
  const remote = await git(pluginDir, ['remote', 'get-url', 'origin']).catch(() => '')
  const owner = parseGitRepositoryIdentity(remote)?.owner
  const { publisher } = JSON.parse(readFileSync(path.join(pluginDir, 'orca-plugin.json'), 'utf8'))
  return owner && owner.toLowerCase() !== publisher.toLowerCase()
    ? `warning: the official and community catalogs require publisher to match the repository owner "${owner}" (publisher is "${publisher}")`
    : null
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
    if (errors.length === 0 && path.basename(file) === 'orca-plugin.json') {
      const { manifest } = parsePluginManifest(raw)
      errors.push(
        ...artifactErrors(root, manifest),
        ...languagePackErrors(root, manifest),
        ...syntaxConfigurationErrors(root, manifest)
      )
    }
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
    const { entry, sourcePath, note } = await catalogReleaseEntry(target)
    if (sourcePath) {
      console.log(
        `\nCatalog source path (set "path" in this plugin's "source"): ${JSON.stringify(sourcePath)}`
      )
    }
    if (entry) {
      console.log(
        `\nCatalog release entry for HEAD (newest first in "releases"):\n${JSON.stringify(entry, null, 2)}`
      )
    }
    if (note) {
      console.log(`${target}: ${note}`)
    }
    const ownerWarning = await publisherOwnerWarning(target)
    if (ownerWarning) {
      console.warn(`${target}: ${ownerWarning}`)
    }
  }
}
process.exit(failed ? 1 : 0)
