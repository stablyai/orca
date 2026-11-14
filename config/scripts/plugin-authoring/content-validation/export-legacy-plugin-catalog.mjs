// Writes the frozen orca-marketplace.json that Orca builds before catalog format 2 read, from
// orca-catalog.json. Why generated: those builds reject any key they do not know, so the file
// carries only the original fields and authors should never edit it by hand.
// Usage: node export-legacy-plugin-catalog.mjs [orca-catalog.json] [orca-marketplace.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Projects a format 2 catalog onto the frozen format 1 shape. */
export function legacyPluginCatalog(catalog) {
  return {
    name: catalog.name,
    owner: catalog.owner,
    // Why skipped: format 1 has no `path`, so those builds would install the repository root.
    plugins: catalog.plugins
      .filter((entry) => !entry.source.path)
      .map((entry) => ({
        id: entry.id,
        source: { kind: entry.source.kind, url: entry.source.url, ref: entry.source.ref },
        ...(entry.description ? { description: entry.description } : {}),
        categories: entry.categories ?? []
      }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const input = process.argv[2] ?? 'orca-catalog.json'
  const output = process.argv[3] ?? 'orca-marketplace.json'
  const catalog = JSON.parse(readFileSync(input, 'utf8'))
  writeFileSync(output, `${JSON.stringify(legacyPluginCatalog(catalog), null, 2)}\n`)
  console.log(`wrote ${output} with ${catalog.plugins.length} plugins`)
}
