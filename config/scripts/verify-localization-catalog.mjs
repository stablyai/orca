import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['.git', 'dist', 'node_modules', 'out', '__snapshots__', 'assets'])
const LOCALIZATION_FUNCTION_NAMES = new Set(['t', 'translate', 'translateMain'])
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g
const LOCALES_RELATIVE_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const SOURCE_RELATIVE_ROOTS = [path.join('src', 'renderer', 'src'), path.join('src', 'main')]

function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function isSkippedFile(root, filePath) {
  const relative = normalizePath(root, filePath)
  if (
    relative.endsWith('.d.ts') ||
    relative.includes('.test.') ||
    relative.includes('.spec.') ||
    relative.includes('/__tests__/')
  ) {
    return true
  }
  return relative.split('/').some((part) => SKIP_PATH_PARTS.has(part))
}

async function collectSourceFiles(root, dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_PATH_PARTS.has(entry.name)) {
        files.push(...(await collectSourceFiles(root, fullPath)))
      }
      continue
    }
    if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !isSkippedFile(root, fullPath)
    ) {
      files.push(fullPath)
    }
  }

  return files
}

function flattenCatalogKeys(value, prefix = '') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return prefix ? [prefix] : []
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenCatalogKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

function expressionNameText(node) {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionNameText(node.expression) ?? ''}.${node.name.text}`.replace(/^\./, '')
  }
  return undefined
}

function reportAt(root, filePath, sourceFile, node, key, fallback) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    filePath: normalizePath(root, filePath),
    line: position.line + 1,
    column: position.character + 1,
    key,
    fallback
  }
}

export function collectLocalizationKeyReferences(filePath, sourceText, root = process.cwd()) {
  const sourceKind =
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const references = []

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = expressionNameText(node.expression)
      const functionName = name?.split('.').at(-1)
      const firstArg = node.arguments[0]
      if (
        functionName &&
        LOCALIZATION_FUNCTION_NAMES.has(functionName) &&
        firstArg &&
        ts.isStringLiteralLike(firstArg)
      ) {
        const secondArg = node.arguments[1]
        references.push(
          reportAt(
            root,
            filePath,
            sourceFile,
            firstArg,
            firstArg.text,
            secondArg && ts.isStringLiteralLike(secondArg) ? secondArg.text : undefined
          )
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

function formatMissingReferences(missing) {
  return missing
    .map(
      (reference) => `${reference.filePath}:${reference.line}:${reference.column} ${reference.key}`
    )
    .join('\n')
}

function formatMissingKeys(label, keys) {
  return keys.map((key) => `${label}: ${key}`).join('\n')
}

function normalizeInterpolationVariables(value) {
  return collectInterpolationVariables(value)
    .map((variable) => variable.slice(2, -2))
    .join('|')
}

function formatInconsistentFallbackVariables(inconsistentFallbackVariables) {
  return inconsistentFallbackVariables
    .map(({ key, references }) => {
      const locations = references
        .map(
          (reference) =>
            `  ${reference.filePath}:${reference.line}:${reference.column} ${JSON.stringify(reference.fallback)}`
        )
        .join('\n')
      return `${key}\n${locations}`
    })
    .join('\n\n')
}

function collectInconsistentFallbackVariables(references) {
  const byKey = new Map()

  for (const reference of references) {
    if (typeof reference.fallback !== 'string') {
      continue
    }
    const existing = byKey.get(reference.key) ?? []
    existing.push(reference)
    byKey.set(reference.key, existing)
  }

  return [...byKey.entries()]
    .map(([key, keyReferences]) => {
      const uniqueFallbackVariables = new Set(
        keyReferences.map((reference) => normalizeInterpolationVariables(reference.fallback))
      )
      return {
        key,
        references: keyReferences,
        uniqueFallbackVariableCount: uniqueFallbackVariables.size
      }
    })
    .filter(({ uniqueFallbackVariableCount }) => uniqueFallbackVariableCount > 1)
}

function collectInterpolationVariables(value) {
  if (typeof value === 'string') {
    const matches = value.match(PLACEHOLDER_RE) ?? []
    return [...matches].sort()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }
  return Object.values(value).flatMap((child) => collectInterpolationVariables(child))
}

function flattenCatalogEntries(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalogEntries(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

function getCatalogEntry(catalog, key) {
  return key.split('.').reduce((cursor, part) => cursor?.[part], catalog)
}

function setCatalogEntry(catalog, key, value) {
  const parts = key.split('.')
  let cursor = catalog
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

function deleteCatalogEntry(catalog, key) {
  const parts = key.split('.')
  const stack = []
  let cursor = catalog

  for (const part of parts.slice(0, -1)) {
    if (
      typeof cursor?.[part] !== 'object' ||
      cursor[part] === null ||
      Array.isArray(cursor[part])
    ) {
      return false
    }
    stack.push([cursor, part])
    cursor = cursor[part]
  }

  const leafKey = parts.at(-1)
  if (!Object.hasOwn(cursor, leafKey)) {
    return false
  }

  delete cursor[leafKey]
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const [parent, part] = stack[index]
    const child = parent[part]
    if (
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      Object.keys(child).length === 0
    ) {
      delete parent[part]
    }
  }
  return true
}

function collectLocaleParityIssues(enCatalog, localeCatalog) {
  const enEntries = flattenCatalogEntries(enCatalog)
  const localeEntries = flattenCatalogEntries(localeCatalog)
  const missingInLocale = [...enEntries.keys()].filter((key) => !localeEntries.has(key))
  const extraInLocale = [...localeEntries.keys()].filter((key) => !enEntries.has(key))
  const interpolationMismatches = []

  for (const key of enEntries.keys()) {
    if (!localeEntries.has(key)) {
      continue
    }
    const enVariables = collectInterpolationVariables(enEntries.get(key))
    const localeVariables = collectInterpolationVariables(localeEntries.get(key))
    if (enVariables.join('|') !== localeVariables.join('|')) {
      interpolationMismatches.push(key)
    }
  }

  return { enEntries, localeEntries, missingInLocale, extraInLocale, interpolationMismatches }
}

function repairLocaleParity(enCatalog, localeCatalog) {
  const { enEntries, missingInLocale, extraInLocale, interpolationMismatches } =
    collectLocaleParityIssues(enCatalog, localeCatalog)
  let changed = 0

  for (const key of missingInLocale) {
    setCatalogEntry(localeCatalog, key, enEntries.get(key))
    changed += 1
  }

  for (const key of extraInLocale) {
    if (deleteCatalogEntry(localeCatalog, key)) {
      changed += 1
    }
  }

  for (const key of interpolationMismatches) {
    setCatalogEntry(localeCatalog, key, enEntries.get(key))
    changed += 1
  }

  return changed
}

function referencesMissingFallbacks(missing) {
  return missing.filter((reference) => typeof reference.fallback !== 'string')
}

function collectMissingCatalogEntries(missing) {
  const entries = new Map()

  for (const reference of missing) {
    if (typeof reference.fallback !== 'string') {
      continue
    }
    if (!entries.has(reference.key)) {
      entries.set(reference.key, reference.fallback)
    }
  }

  return entries
}

function applyMissingEnglishEntries(catalog, missing) {
  const entries = collectMissingCatalogEntries(missing)
  let changed = 0

  for (const [key, fallback] of entries) {
    if (getCatalogEntry(catalog, key) !== undefined) {
      continue
    }
    setCatalogEntry(catalog, key, fallback)
    changed += 1
  }

  return changed
}

function verifyLocaleParity(enCatalog, localeName, localeCatalog) {
  const { localeEntries, missingInLocale, extraInLocale, interpolationMismatches } =
    collectLocaleParityIssues(enCatalog, localeCatalog)

  if (
    missingInLocale.length > 0 ||
    extraInLocale.length > 0 ||
    interpolationMismatches.length > 0
  ) {
    console.error(`Locale catalog parity failed for ${localeName}.json.`)
    if (missingInLocale.length > 0) {
      console.error('')
      console.error(formatMissingKeys('missing', missingInLocale.slice(0, 20)))
      if (missingInLocale.length > 20) {
        console.error(`...and ${missingInLocale.length - 20} more missing keys`)
      }
    }
    if (extraInLocale.length > 0) {
      console.error('')
      console.error(formatMissingKeys('extra', extraInLocale.slice(0, 20)))
      if (extraInLocale.length > 20) {
        console.error(`...and ${extraInLocale.length - 20} more extra keys`)
      }
    }
    if (interpolationMismatches.length > 0) {
      console.error('')
      console.error(
        formatMissingKeys('interpolation mismatch', interpolationMismatches.slice(0, 20))
      )
      if (interpolationMismatches.length > 20) {
        console.error(`...and ${interpolationMismatches.length - 20} more interpolation mismatches`)
      }
    }
    return 1
  }

  console.log(`Verified locale parity for ${localeName}.json (${localeEntries.size} keys).`)
  return 0
}

function parseArgs(argv) {
  return {
    fix: argv.includes('--fix')
  }
}

export async function main(root = process.cwd(), options = parseArgs(process.argv.slice(2))) {
  const localesDir = path.join(root, LOCALES_RELATIVE_DIR)
  const catalogPath = path.join(localesDir, 'en.json')
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  let catalogKeys = new Set(flattenCatalogKeys(catalog))
  const sourceRoots = SOURCE_RELATIVE_ROOTS.map((sourceRoot) => path.join(root, sourceRoot))
  const references = []

  for (const sourceRoot of sourceRoots) {
    const files = await collectSourceFiles(root, sourceRoot)
    for (const filePath of files) {
      references.push(
        ...collectLocalizationKeyReferences(filePath, await fs.readFile(filePath, 'utf8'), root)
      )
    }
  }

  const missing = references.filter((reference) => !catalogKeys.has(reference.key))
  if (missing.length > 0) {
    const missingFallbacks = referencesMissingFallbacks(missing)
    if (options.fix && missingFallbacks.length === 0) {
      const added = applyMissingEnglishEntries(catalog, missing)
      await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
      catalogKeys = new Set(flattenCatalogKeys(catalog))
      console.log(`Added ${added} missing localization key(s) to en.json.`)
    } else {
      if (options.fix && missingFallbacks.length > 0) {
        console.error('Some missing localization keys do not have string fallbacks to bootstrap.')
        console.error('')
        console.error(formatMissingReferences(missingFallbacks))
        return 1
      }
      console.error('Localization keys are missing from src/renderer/src/i18n/locales/en.json.')
      console.error('')
      console.error(formatMissingReferences(missing))
      console.error('')
      console.error('Run `pnpm run sync:localization-catalog` to add keys with string fallbacks.')
      return 1
    }
  }

  const remainingMissing = references.filter((reference) => !catalogKeys.has(reference.key))
  if (remainingMissing.length > 0) {
    console.error('Localization keys are missing from src/renderer/src/i18n/locales/en.json.')
    console.error('')
    console.error(formatMissingReferences(remainingMissing))
    return 1
  }

  const inconsistentFallbackVariables = collectInconsistentFallbackVariables(references)
  if (inconsistentFallbackVariables.length > 0) {
    console.error('Localization keys are used with inconsistent interpolation placeholders.')
    console.error('')
    console.error(formatInconsistentFallbackVariables(inconsistentFallbackVariables))
    return 1
  }

  console.log(`Verified ${references.length} localization key references against en.json.`)

  const localeFiles = (await fs.readdir(localesDir))
    .filter(
      (fileName) =>
        fileName.endsWith('.json') &&
        fileName !== 'en.json' &&
        !fileName.startsWith('.') &&
        !fileName.includes('-catalog-cache')
    )
    .sort()

  for (const fileName of localeFiles) {
    const localeName = fileName.replace(/\.json$/, '')
    const localeCatalogPath = path.join(localesDir, fileName)
    const localeCatalog = JSON.parse(await fs.readFile(localeCatalogPath, 'utf8'))
    if (options.fix) {
      const repaired = repairLocaleParity(catalog, localeCatalog)
      if (repaired > 0) {
        await fs.writeFile(localeCatalogPath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')
        console.log(`Repaired ${fileName} parity (${repaired} key update(s)).`)
      }
    }
    const exitCode = verifyLocaleParity(catalog, localeName, localeCatalog)
    if (exitCode !== 0) {
      if (!options.fix) {
        console.error('')
        console.error('Run `pnpm run sync:localization-catalog` to repair locale parity.')
      }
      return exitCode
    }
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
