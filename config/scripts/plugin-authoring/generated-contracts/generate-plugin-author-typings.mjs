// Generate the host API typings `orca plugin types` copies into plugins, from the host-API table.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPluginSchemaModule, REPO_ROOT } from './plugin-schema-module-loader.mjs'

const { PLUGIN_HOST_TYPINGS_FILE, renderPluginHostTypings } = loadPluginSchemaModule(
  'authoring/plugin-host-typings.ts'
)
const target = path.join(REPO_ROOT, ...PLUGIN_HOST_TYPINGS_FILE.split('/'))
mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(target, renderPluginHostTypings())
console.log(`wrote ${PLUGIN_HOST_TYPINGS_FILE}`)
