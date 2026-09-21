import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)

// Why: a key can leave the code without leaving the catalog — a reverted feature,
// a setting rewritten in place, a component deleted. Nothing fails when that
// happens, so the entries accumulate: every locale carries them, translators
// spend effort on strings no screen renders, and coverage numbers understate how
// much of the product is actually translated.
//
// Extraction alone is not enough to call a key dead. i18next-cli reads
// `translate('literal')` and constants it can resolve, but not a key stored in a
// data structure (`{ key: '…' }`) or built from a namespace variable. So a key is
// reported here only when it survives every check below.

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const EN_CATALOG = path.join(LOCALES_DIR, 'en.json')
// Every root that can reference a catalog key at runtime.
const SOURCE_GLOBS = ['src', 'mobile']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
// Mirror the ignore list in config/i18next.config.ts. A key named only by a test
// is dead for the product, and counting it as live would let an obsolete
// assertion pin a key no screen renders.
const NON_RUNTIME_DIR = new Set(['node_modules', 'locales', '__tests__', '__snapshots__', 'assets'])
const NON_RUNTIME_FILE = /\.(test|spec)\./
// A catalog key never looks like a word; require a dot and a reasonable length so
// the literal scan does not drown in ordinary strings.
const KEY_SHAPED = /^[A-Za-z][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$/
// i18next appends a CLDR category to the base key and resolves it at runtime, so
// `…count_one` never appears in a source file even though `…count` does. Judge
// the base key instead, or the prune eats every plural variant in the catalog.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function flattenCatalog(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

async function collectSourceFiles(root) {
  const files = []
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (NON_RUNTIME_DIR.has(entry.name)) {
          continue
        }
        await walk(full)
      } else if (
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !NON_RUNTIME_FILE.test(entry.name)
      ) {
        files.push(full)
      }
    }
  }
  for (const glob of SOURCE_GLOBS) {
    await walk(path.join(root, glob))
  }
  return files
}

/** Every key-shaped string literal that appears anywhere in the sources. */
async function collectLiteralStrings(files) {
  const found = new Set()
  const literal = /['"`]([A-Za-z][A-Za-z0-9._-]{6,})['"`]/g
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    for (const match of text.matchAll(literal)) {
      if (KEY_SHAPED.test(match[1])) {
        found.add(match[1])
      }
    }
  }
  return found
}

async function extractReferencedKeys(root) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orphan-scan-'))
  try {
    const cli = path.join(root, 'node_modules', 'i18next-cli', 'dist', 'esm', 'cli.js')
    const output = path.join(tempDir, '{{language}}.json').split(path.sep).join('/')
    await execFileAsync(
      process.execPath,
      [cli, '--config', 'config/i18next.config.ts', 'extract', '--sync-primary', '--quiet'],
      { cwd: root, env: { ...process.env, ORCA_I18N_EXTRACTION_OUTPUT: output } }
    )
    return flattenCatalog(JSON.parse(await fs.readFile(path.join(tempDir, 'en.json'), 'utf8')))
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

export async function findOrphanedKeys(root = process.cwd()) {
  const english = flattenCatalog(JSON.parse(await fs.readFile(path.join(root, EN_CATALOG), 'utf8')))
  const referenced = await extractReferencedKeys(root)
  const literals = await collectLiteralStrings(await collectSourceFiles(root))
  const isReferenced = (key) => {
    if (referenced.has(key) || literals.has(key)) {
      return true
    }
    const base = key.replace(PLURAL_SUFFIX, '')
    return base !== key && (referenced.has(base) || literals.has(base) || english.has(base))
  }
  const orphans = [...english.keys()].filter((key) => !isReferenced(key))
  return { total: english.size, referenced: referenced.size, orphans }
}

async function main(root = process.cwd()) {
  // Why --check: without a gate the prune regrows. verify:localization-extraction
  // already computes the unreferenced set but only fails on keys missing from
  // English, so a reverted feature strands its keys and nothing notices.
  const check = process.argv.includes('--check')
  const { total, referenced, orphans } = await findOrphanedKeys(root)
  console.log(
    `${total} keys in en.json; ${referenced} referenced by extraction; ${orphans.length} unreferenced by extraction and absent from every source literal.`
  )
  for (const key of orphans) {
    console.log(key)
  }
  if (check && orphans.length > 0) {
    console.error(
      `\n${orphans.length} catalog ${orphans.length === 1 ? 'key is' : 'keys are'} unreachable. Delete them from every locale, then regenerate with \`pnpm run sync:localization-runtime-catalog\`. Removing a base key can strand its plural variants, so re-run until this reports none.`
    )
    process.exitCode = 1
  }
  return orphans.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
