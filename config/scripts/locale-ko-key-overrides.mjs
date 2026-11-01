import fs from 'node:fs'
import path from 'node:path'

// Load context-reviewed Korean key overrides from one JSON source to stay under module line cap.
const jsonPath = path.join(import.meta.dirname, 'locale-ko-key-overrides.json')

let parsed
try {
  parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
} catch (error) {
  // Name the file: a bare JSON.parse SyntaxError doesn't say which file failed.
  throw new Error(`Failed to load ${path.basename(jsonPath)}: ${error.message}`)
}

export const KO_KEY_OVERRIDES = parsed
