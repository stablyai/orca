import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const EN_CATALOG_PATH = path.join('src', 'renderer', 'src', 'i18n', 'locales', 'en.json')
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

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

function placeholders(value) {
  return [...(value.match(PLACEHOLDER_RE) ?? [])].sort().join('|')
}

export function compareExtraction(extractedCatalog, englishCatalog) {
  const extracted = flattenCatalog(extractedCatalog)
  const english = flattenCatalog(englishCatalog)
  const dynamicDefaults = [...extracted.entries()]
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key)
  const missingFromEnglish = [...extracted.keys()].filter((key) => !english.has(key))
  const orphans = [...english.keys()].filter((key) => !extracted.has(key))
  const fallbackDrift = []
  const placeholderMismatches = []

  for (const [key, extractedValue] of extracted) {
    const englishValue = english.get(key)
    if (
      extractedValue.length === 0 ||
      englishValue === undefined ||
      englishValue === extractedValue
    ) {
      continue
    }
    fallbackDrift.push(key)
    if (placeholders(extractedValue) !== placeholders(englishValue)) {
      placeholderMismatches.push(key)
    }
  }

  return {
    extracted,
    dynamicDefaults,
    missingFromEnglish,
    orphans,
    fallbackDrift,
    placeholderMismatches
  }
}

function printKeys(label, keys) {
  if (keys.length === 0) {
    return
  }
  console.error(`${label}:`)
  for (const key of keys.slice(0, 20)) {
    console.error(`  ${key}`)
  }
  if (keys.length > 20) {
    console.error(`  ...and ${keys.length - 20} more`)
  }
}

async function extractToTemporaryCatalog(root, tempDir) {
  const cliPath = path.join(root, 'node_modules', 'i18next-cli', 'dist', 'esm', 'cli.js')
  const outputPattern = path.join(tempDir, '{{language}}.json')
  // Why: extraction output is evidence for this check, not another committed
  // catalog that feature authors must keep synchronized.
  await execFileAsync(process.execPath, [cliPath, 'extract', '--sync-primary', '--quiet'], {
    cwd: root,
    env: {
      ...process.env,
      ORCA_I18N_EXTRACTION_OUTPUT: outputPattern.split(path.sep).join('/')
    }
  })
  return JSON.parse(await fs.readFile(path.join(tempDir, 'en.json'), 'utf8'))
}

export async function main(root = process.cwd()) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-i18next-extraction-'))

  try {
    const [extractedCatalog, englishCatalog] = await Promise.all([
      extractToTemporaryCatalog(root, tempDir),
      fs.readFile(path.join(root, EN_CATALOG_PATH), 'utf8').then(JSON.parse)
    ])
    const result = compareExtraction(extractedCatalog, englishCatalog)

    console.log(
      `Extracted ${result.extracted.size} keys; ${result.dynamicDefaults.length} dynamic defaults are report-only, ${result.orphans.length} existing English entries are not statically referenced, and ${result.fallbackDrift.length} inline defaults differ.`
    )

    if (result.missingFromEnglish.length > 0 || result.placeholderMismatches.length > 0) {
      printKeys('Extracted keys missing from en.json', result.missingFromEnglish)
      printKeys('Extracted defaults with incompatible placeholders', result.placeholderMismatches)
      return 1
    }

    return 0
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
