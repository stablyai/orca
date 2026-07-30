import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const SOURCE_RELATIVE_ROOTS = [path.join('mobile', 'app'), path.join('mobile', 'src')]
const LOCALES_RELATIVE_DIR = path.join('mobile', 'src', 'i18n', 'locales')
const MOBILE_LOCALES = ['en', 'es', 'ja', 'ko', 'zh']
const PLACEHOLDER_RE = /\{\{\s*([^,}\s]+)(?:,[^}]*)?\}\}/g
const ENCODED_HTML_ENTITY_RE = /&(?:amp|apos|gt|lt|quot);/i

function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function isSourceFile(filePath) {
  const fileName = path.basename(filePath)
  return (
    SOURCE_EXTENSIONS.has(path.extname(fileName)) &&
    !fileName.includes('.test.') &&
    !fileName.includes('.spec.')
  )
}

async function collectSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(filePath)))
    } else if (entry.isFile() && isSourceFile(filePath)) {
      files.push(filePath)
    }
  }

  return files
}

function flattenCatalog(value, catalogName, prefix = '', entries = new Map(), issues = []) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    if (ENCODED_HTML_ENTITY_RE.test(value)) {
      issues.push(`${catalogName}: ${prefix} contains an encoded HTML entity`)
    }
    return { entries, issues }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${catalogName}: ${prefix || '<root>'} must be a string or object`)
    return { entries, issues }
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, catalogName, prefix ? `${prefix}.${key}` : key, entries, issues)
  }
  return { entries, issues }
}

function locationFor(root, filePath, sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${normalizePath(root, filePath)}:${position.line + 1}:${position.character + 1}`
}

function unwrapExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return unwrapExpression(node.expression)
  }
  return node
}

function collectKeyBranches(node) {
  const expression = unwrapExpression(node)
  if (ts.isStringLiteralLike(expression)) {
    return { keys: [expression.text], inspected: true }
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = collectKeyBranches(expression.whenTrue)
    const whenFalse = collectKeyBranches(expression.whenFalse)
    return {
      keys: [...whenTrue.keys, ...whenFalse.keys],
      inspected: whenTrue.inspected && whenFalse.inspected
    }
  }
  return { keys: [], inspected: false }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return undefined
}

function collectOptionNames(node) {
  if (!node) {
    return { inspected: true, names: [] }
  }
  const expression = unwrapExpression(node)
  if (!ts.isObjectLiteralExpression(expression)) {
    return { inspected: false, names: [] }
  }

  const names = []
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.push(property.name.text)
      continue
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name)
      if (name !== undefined) {
        names.push(name)
        continue
      }
    }
    return { inspected: false, names: [] }
  }
  return { inspected: true, names: [...new Set(names)].sort() }
}

function collectPlaceholderNames(value) {
  const names = []
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    names.push(match[1])
  }
  return [...new Set(names)].sort()
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function collectMobileTranslationCalls(filePath, sourceText, root = process.cwd()) {
  const sourceKind =
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const calls = []

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 't'
    ) {
      const keyExpression = node.arguments[0]
      if (keyExpression) {
        calls.push({
          ...collectKeyBranches(keyExpression),
          location: locationFor(root, filePath, sourceFile, keyExpression),
          options: collectOptionNames(node.arguments[1]),
          source: keyExpression.getText(sourceFile)
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return calls
}

function verifyCalls(calls, englishEntries) {
  const issues = []

  for (const call of calls) {
    if (!call.inspected) {
      issues.push(
        `${call.location} translation key expression is not statically inspectable: ${call.source}`
      )
      continue
    }
    if (!call.options.inspected) {
      issues.push(`${call.location} translation options are not statically inspectable`)
      continue
    }
    for (const key of call.keys) {
      const englishValue = englishEntries.get(key)
      if (englishValue === undefined) {
        issues.push(`${call.location} missing English key: ${key}`)
        continue
      }
      const placeholders = collectPlaceholderNames(englishValue)
      if (!sameValues(call.options.names, placeholders)) {
        issues.push(
          `${call.location} ${key} options [${call.options.names.join(', ')}] do not match placeholders [${placeholders.join(', ')}]`
        )
      }
    }
  }

  return issues
}

function verifyLocaleParity(englishEntries, locale, localeEntries) {
  const issues = []
  const englishKeys = [...englishEntries.keys()].sort()
  const localeKeys = [...localeEntries.keys()].sort()

  for (const key of englishKeys) {
    if (!localeEntries.has(key)) {
      issues.push(`${locale}.json missing key: ${key}`)
      continue
    }
    const englishPlaceholders = collectPlaceholderNames(englishEntries.get(key))
    const localePlaceholders = collectPlaceholderNames(localeEntries.get(key))
    if (!sameValues(englishPlaceholders, localePlaceholders)) {
      issues.push(`${locale}.json placeholder mismatch: ${key}`)
    }
  }
  for (const key of localeKeys) {
    if (!englishEntries.has(key)) {
      issues.push(`${locale}.json has extra key: ${key}`)
    }
  }

  return issues
}

async function readCatalogs(root) {
  const localeDirectory = path.join(root, LOCALES_RELATIVE_DIR)
  const catalogs = new Map()
  const issues = []

  for (const locale of MOBILE_LOCALES) {
    const catalogPath = path.join(localeDirectory, `${locale}.json`)
    try {
      const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
      const flattened = flattenCatalog(catalog, `${locale}.json`)
      catalogs.set(locale, flattened.entries)
      issues.push(...flattened.issues)
    } catch (error) {
      issues.push(
        `${normalizePath(root, catalogPath)} could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return { catalogs, issues }
}

function reportIssues(issues) {
  console.error(`Mobile localization catalog verification failed with ${issues.length} issue(s).`)
  for (const issue of issues.slice(0, 100)) {
    console.error(issue)
  }
  if (issues.length > 100) {
    console.error(`...and ${issues.length - 100} more`)
  }
}

export async function main(root = process.cwd()) {
  const { catalogs, issues } = await readCatalogs(root)
  const englishEntries = catalogs.get('en')
  if (!englishEntries) {
    reportIssues(issues)
    return 1
  }

  const calls = []
  for (const relativeRoot of SOURCE_RELATIVE_ROOTS) {
    const sourceRoot = path.join(root, relativeRoot)
    for (const filePath of await collectSourceFiles(sourceRoot)) {
      calls.push(
        ...collectMobileTranslationCalls(filePath, await fs.readFile(filePath, 'utf8'), root)
      )
    }
  }

  issues.push(...verifyCalls(calls, englishEntries))
  for (const locale of MOBILE_LOCALES.slice(1)) {
    const localeEntries = catalogs.get(locale)
    if (localeEntries) {
      issues.push(...verifyLocaleParity(englishEntries, locale, localeEntries))
    }
  }

  if (issues.length > 0) {
    reportIssues(issues)
    return 1
  }
  console.log(
    `Verified ${calls.length} mobile translation calls and ${englishEntries.size} catalog keys across ${MOBILE_LOCALES.length} locales.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
