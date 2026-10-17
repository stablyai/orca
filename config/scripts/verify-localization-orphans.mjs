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
// A checkout without the mobile app is still a complete desktop scan.
const OPTIONAL_SOURCE_GLOB = 'mobile'
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
// Mirror the ignore list in config/i18next.config.ts. A key named only by a test
// is dead for the product, and counting it as live would let an obsolete
// assertion pin a key no screen renders.
const NON_RUNTIME_DIR = new Set(['node_modules', 'locales', '__tests__', '__snapshots__', 'assets'])
const NON_RUNTIME_FILE = /\.(test|spec)\./
// A catalog key never looks like a word; require a dot so the literal scan does
// not drown in ordinary strings.
const CATALOG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$/
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

// Exported for the unit tests: a directory this walk skips hides its literals,
// and a key named only there would be reported as dead.
export async function collectSourceFiles(root) {
  const files = []
  const optionalRoot = path.join(root, OPTIONAL_SOURCE_GLOB)
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (dir === optionalRoot && error.code === 'ENOENT') {
        return
      }
      throw error
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
// Exported for the unit tests: the scan is what makes a key referenced when
// extraction cannot see it — a key held in a data structure or passed as a
// variable — so its shape filter deserves cases of its own.
export function collectLiteralKeys(text, found = new Set()) {
  // Why no length floor: this capture only finds candidates. A minimum here
  // that CATALOG_KEY_PATTERN does not share would call a short live key an orphan.
  const literal = /['"`]([A-Za-z][A-Za-z0-9._-]*)['"`]/g
  for (const match of text.matchAll(literal)) {
    if (CATALOG_KEY_PATTERN.test(match[1])) {
      found.add(match[1])
    }
  }
  return found
}

async function collectLiteralStrings(files) {
  const found = new Set()
  for (const file of files) {
    collectLiteralKeys(await fs.readFile(file, 'utf8'), found)
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

// Exported for the unit tests: the plural rule is the one place where a key
// absent from every source is still live, so it has to stay provable on its own.
// A base key that only the catalog carries is no evidence: nothing can reach its
// variants either, and counting it would hide them until the base key is pruned.
export function isKeyReferenced(key, { referenced, literals }) {
  if (referenced.has(key) || literals.has(key)) {
    return true
  }
  const base = key.replace(PLURAL_SUFFIX, '')
  return base !== key && (referenced.has(base) || literals.has(base))
}

// Why `extracted`: verify:localization-extraction has already paid for the AST
// pass, so the gate hands its result in rather than extracting a second time.
export async function findOrphanedKeys(root = process.cwd(), extracted) {
  const english = flattenCatalog(JSON.parse(await fs.readFile(path.join(root, EN_CATALOG), 'utf8')))
  const referenced = extracted ?? (await extractReferencedKeys(root))
  const literals = await collectLiteralStrings(await collectSourceFiles(root))
  const orphans = [...english.keys()].filter(
    (key) => !isKeyReferenced(key, { referenced, literals })
  )
  return { total: english.size, referenced: referenced.size, orphans }
}

async function main(root = process.cwd()) {
  // Why --check: without a gate the prune regrows — a reverted feature strands
  // its keys and nothing notices. verify:localization-extraction applies the
  // same test on its own pass; this is the standalone way to run and list it.
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
      `\n${orphans.length} catalog ${orphans.length === 1 ? 'key is' : 'keys are'} unreachable. Delete them from every locale, then regenerate with \`pnpm run sync:localization-runtime-catalog\`. The override tables in config/scripts/locale-*key-overrides.* are outside this scan and may still name them.`
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
