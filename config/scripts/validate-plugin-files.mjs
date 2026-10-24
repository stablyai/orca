// Strict check of plugin manifests and catalogs, for authors and catalog CI.
// Usage: node config/scripts/validate-plugin-files.mjs <plugin dir | orca-plugin.json | orca-catalog.json>...
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { loadPluginSchemaModule } from './plugin-schema-module-loader.mjs'

const { validatePluginFile } = loadPluginSchemaModule('plugin-file-validation.ts')
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
    }
  }
}
process.exit(failed ? 1 : 0)
