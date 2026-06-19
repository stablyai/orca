import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Korean key-specific overrides (reviewed in full UI context: product names, git terms, and
// labels MT mistranslated). Stored as a JSON data file — too many entries to inline under the
// .mjs max-lines limit — and loaded here so the catalog scripts keep a single ko key-override source.
const jsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locale-ko-key-overrides.json')

let parsed
try {
  parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
} catch (error) {
  // Name the file: a bare JSON.parse SyntaxError doesn't say which file failed.
  throw new Error(`Failed to load ${path.basename(jsonPath)}: ${error.message}`)
}

export const KO_KEY_OVERRIDES = parsed
