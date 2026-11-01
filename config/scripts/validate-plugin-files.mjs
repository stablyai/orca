// Strict check of plugin manifests and catalogs, for authors and catalog CI.
// Usage: node config/scripts/validate-plugin-files.mjs <plugin dir | orca-plugin.json | orca-catalog.json>...
// For a plugin directory in a Git repository it also prints the catalog release entry for the
// committed HEAD, with the `source.path` to list when the plugin is not the repository root.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { loadPluginSchemaModule, REPO_ROOT } from './plugin-schema-module-loader.mjs'

const { validatePluginFile, pluginManifestWarnings } = loadPluginSchemaModule(
  'installation/plugin-file-validation.ts'
)
const { parsePluginManifest } = loadPluginSchemaModule('manifest/plugin-manifest.ts')
// Why the CLI's main entry: `orca plugin validate` and `release-entry` run these same checks, and
// the printed contentHash must be what Orca computes at install.
const {
  pluginCatalogReleaseForHead,
  validateDeclaredPluginArtifacts,
  validatePluginInstallContent
} = loadPluginSchemaModule('../../main/plugins/plugin-authoring-checks.ts')
// Why shared: `orca plugin validate` runs these same strict artifact checks.
const { strictPluginArtifactErrors } = loadPluginSchemaModule(
  'authoring/plugin-strict-artifact-checks.ts'
)

const { englishSourceLookup } = loadPluginSchemaModule(
  'languages/plugin-translation-string-policy.ts'
)
let englishSource = null
// Why Orca's English: pack strings are capped relative to the text they translate.
function englishLookup() {
  englishSource ??= englishSourceLookup(
    JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, 'src', 'renderer', 'src', 'i18n', 'locales', 'en.json'),
        'utf8'
      )
    )
  )
  return englishSource
}

function readPluginText(pluginDir) {
  return (manifestPath) => {
    const file = path.join(pluginDir, ...manifestPath.split('/'))
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
}

// Why the install checks too: they report a named file that is missing, unreadable or too large.
async function installContentErrors(root, manifest) {
  const errors = []
  for (const check of [validateDeclaredPluginArtifacts, validatePluginInstallContent]) {
    const result = await check(root, manifest)
    if (!result.ok) {
      errors.push(result.error)
    }
  }
  return errors
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
  if (!existsSync(target)) {
    console.error(`${target}: does not exist`)
    failed = true
    continue
  }
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
      errors.push(...strictPluginArtifactErrors(manifest, readPluginText(root), englishLookup()))
      errors.push(...(await installContentErrors(root, manifest)))
    }
    for (const error of errors) {
      console.error(`${file}: ${error}`)
    }
    if (errors.length === 0 && path.basename(file) === 'orca-plugin.json') {
      for (const warning of pluginManifestWarnings(raw)) {
        console.warn(`${file}: warning: ${warning}`)
      }
    }
    failed ||= errors.length > 0
    if (errors.length === 0) {
      console.log(`${file}: ok`)
      manifestOk ||= path.basename(file) === 'orca-plugin.json'
    }
  }
  if (manifestOk && statSync(target).isDirectory()) {
    const { entry, sourcePath, note, ownerWarning } = await pluginCatalogReleaseForHead(target)
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
    if (ownerWarning) {
      console.warn(`${target}: warning: ${ownerWarning}`)
    }
  }
}
process.exit(failed ? 1 : 0)
