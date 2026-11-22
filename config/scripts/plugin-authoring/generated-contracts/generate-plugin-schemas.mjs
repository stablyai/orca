// Generate published JSON Schemas and author references from the Zod schemas.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPluginSchemaModule, REPO_ROOT } from './plugin-schema-module-loader.mjs'

const files = loadPluginSchemaModule('manifest/plugin-json-schema.ts').pluginSchemaGeneratedFiles()
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(REPO_ROOT, ...relative.split('/'))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  console.log(`wrote ${relative}`)
}
