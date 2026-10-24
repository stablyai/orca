// Why: the zod schemas in src/shared/plugins are the only definition; this writes the published
// JSON Schemas and author references from them. The drift test in plugin-json-schema.test.ts
// fails when these files fall behind.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPluginSchemaModule, REPO_ROOT } from './plugin-schema-module-loader.mjs'

const files = loadPluginSchemaModule('plugin-json-schema.ts').pluginSchemaGeneratedFiles()
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(REPO_ROOT, ...relative.split('/'))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  console.log(`wrote ${relative}`)
}
