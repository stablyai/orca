import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['.git', 'dist', 'node_modules', 'out', '__snapshots__', 'assets'])
const LOCALIZATION_FUNCTION_NAMES = new Set(['t', 'translate', 'translateMain'])
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

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

function reportAt(root, filePath, sourceFile, node, key) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    filePath: normalizePath(root, filePath),
    line: position.line + 1,
    column: position.character + 1,
    key
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
        references.push(reportAt(root, filePath, sourceFile, firstArg, firstArg.text))
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

function verifyLocaleParity(enCatalog, localeName, localeCatalog) {
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

export async function main(root = process.cwd()) {
  const localesDir = path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales')
  const catalogPath = path.join(localesDir, 'en.json')
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const catalogKeys = new Set(flattenCatalogKeys(catalog))
  const sourceRoots = [path.join(root, 'src', 'renderer', 'src'), path.join(root, 'src', 'main')]
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
    console.error('Localization keys are missing from src/renderer/src/i18n/locales/en.json.')
    console.error('')
    console.error(formatMissingReferences(missing))
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
    const exitCode = verifyLocaleParity(catalog, localeName, localeCatalog)
    if (exitCode !== 0) {
      return exitCode
    }
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
