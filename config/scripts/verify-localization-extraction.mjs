import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { collectSourceFiles } from './verify-localization-catalog.mjs'

const EN_CATALOG_PATH = path.join('src', 'renderer', 'src', 'i18n', 'locales', 'en.json')
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g
// Extraction misses keys held in data structures or passed as variables, so any literal naming a key keeps it.
// Scoped to src/ so only changes that trigger this check can change its verdict.
const KEY_LITERAL_SCAN_ROOT = 'src'
const KEY_LITERAL_RE = /['"`]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"`]/g
const DYNAMIC_KEY_HEAD_RE =
  /\b(?:t|translate\w*)\(\s*(?:`([A-Za-z][\w-]*\.[\w.-]*)\$\{|['"]([A-Za-z][\w-]*\.[\w.-]*)['"]\s*\+)/g
// i18next resolves `key_one` etc. from the base key at runtime.
const PLURAL_SUFFIX_RE = /_(?:zero|one|two|few|many|other)$/

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
    english,
    dynamicDefaults,
    missingFromEnglish,
    orphans,
    fallbackDrift,
    placeholderMismatches
  }
}

export function collectKeyLiterals(sourceText, evidence) {
  for (const match of sourceText.matchAll(KEY_LITERAL_RE)) {
    evidence.literals.add(match[1])
  }
  for (const match of sourceText.matchAll(DYNAMIC_KEY_HEAD_RE)) {
    evidence.dynamicPrefixes.add(match[1] ?? match[2])
  }
  return evidence
}

async function collectSourceKeyEvidence(root) {
  const evidence = { literals: new Set(), dynamicPrefixes: new Set() }
  for (const file of await collectSourceFiles(root, path.join(root, KEY_LITERAL_SCAN_ROOT))) {
    collectKeyLiterals(await fs.readFile(file, 'utf8'), evidence)
  }
  return evidence
}

export function findUnreferencedKeys(orphans, extracted, { literals, dynamicPrefixes }) {
  const isNamed = (key) =>
    extracted.has(key) ||
    literals.has(key) ||
    [...dynamicPrefixes].some((prefix) => key.startsWith(prefix))
  return orphans.filter((key) => {
    if (isNamed(key)) {
      return false
    }
    const base = key.replace(PLURAL_SUFFIX_RE, '')
    return base === key || !isNamed(base)
  })
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

function printFallbackDrift(keys, extracted, english) {
  console.error(
    'Inline defaults differ from en.json. The catalog value is what renders, so editing a fallback alone changes nothing.\n' +
      'Set the en.json value to the new copy and update every locale catalog to match, or move the new copy to a new key.'
  )
  for (const key of keys.slice(0, 20)) {
    console.error(`  ${key}`)
    console.error(`    en.json: ${JSON.stringify(english.get(key))}`)
    console.error(`    source:  ${JSON.stringify(extracted.get(key))}`)
  }
  if (keys.length > 20) {
    console.error(`  ...and ${keys.length - 20} more`)
  }
}

async function extractToTemporaryCatalog(root, tempDir) {
  const cliPath = path.join(root, 'node_modules', 'i18next-cli', 'dist', 'esm', 'cli.js')
  const outputPattern = path.join(tempDir, '{{language}}.json')
  // Treat extraction as check evidence, not another committed catalog feature authors must synchronize.
  const [{ runProcessSync }, { describeProcessFailure }, { resolvePinnedBunExecutable }] =
    await Promise.all([
      import('@orca/process-host'),
      import('./process-failure-message.mjs'),
      import('./pinned-bun-executable.mjs')
    ])
  // Missing or unusable optional Bun keeps the existing parent runtime.
  const program = resolvePinnedBunExecutable(root, runProcessSync) ?? process.execPath
  const result = runProcessSync({
    program,
    args: [cliPath, '--config', 'config/i18next.config.ts', 'extract', '--sync-primary', '--quiet'],
    cwd: root,
    env: {
      ...process.env,
      ORCA_I18N_EXTRACTION_OUTPUT: outputPattern.split(path.sep).join('/')
    },
    timeoutMs: null,
    maxOutputBytes: 1024 * 1024
  })
  if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
    throw new Error(`Localization extraction failed: ${describeProcessFailure(result)}`)
  }
  return JSON.parse(await fs.readFile(path.join(tempDir, 'en.json'), 'utf8'))
}

export async function main(root = process.cwd()) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-i18next-extraction-'))

  try {
    const [extractedCatalog, englishCatalog, keyEvidence] = await Promise.all([
      extractToTemporaryCatalog(root, tempDir),
      fs.readFile(path.join(root, EN_CATALOG_PATH), 'utf8').then(JSON.parse),
      collectSourceKeyEvidence(root)
    ])
    const result = compareExtraction(extractedCatalog, englishCatalog)
    const unreferenced = findUnreferencedKeys(result.orphans, result.extracted, keyEvidence)

    console.log(
      `Extracted ${result.extracted.size} keys; ${result.dynamicDefaults.length} dynamic defaults are report-only, ${result.orphans.length} existing English entries are not statically referenced (${unreferenced.length} named nowhere in source), and ${result.fallbackDrift.length} inline defaults differ from en.json.`
    )

    let failed = false
    if (result.missingFromEnglish.length > 0 || result.placeholderMismatches.length > 0) {
      printKeys('Extracted keys missing from en.json', result.missingFromEnglish)
      printKeys('Extracted defaults with incompatible placeholders', result.placeholderMismatches)
      failed = true
    }
    if (result.fallbackDrift.length > 0) {
      printFallbackDrift(result.fallbackDrift, result.extracted, result.english)
      failed = true
    }
    if (unreferenced.length > 0) {
      printKeys(
        'Catalog keys no source references. Delete them from every locale catalog and config/scripts/locale-*-overrides.*, then run `pnpm sync:localization-runtime-catalog`',
        unreferenced
      )
      failed = true
    }

    return failed ? 1 : 0
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
