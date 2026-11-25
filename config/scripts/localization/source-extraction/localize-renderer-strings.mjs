import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import { collectLocalizationCandidates } from './audit-localization-coverage.mjs'

const TRANSLATE_IMPORT = "import { translate } from '@/i18n/i18n'\n"

function keySegment(value) {
  return value
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9]+/g, '.')
    .replace(/(^\.+|\.+$)/g, '')
}

function keyForCandidate(candidate) {
  const withoutPrefix = candidate.filePath.replace(/^src\/renderer\/src\//, '')
  const source = `${candidate.filePath}:${candidate.text}`
  const hash = createHash('sha1').update(source).digest('hex').slice(0, 10)
  return `auto.${keySegment(withoutPrefix)}.${hash}`
}

function setCatalogValue(catalog, key, value) {
  const parts = key.split('.')
  let current = catalog
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {}
    current = current[part]
  }
  current[parts.at(-1)] = value
}

function translateCall(key, value, options) {
  if (options) {
    return `translate(${JSON.stringify(key)}, ${JSON.stringify(value)}, ${options})`
  }
  return `translate(${JSON.stringify(key)}, ${JSON.stringify(value)})`
}

function isInsideJsxExpression(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxExpression(current)) {
      return true
    }
    current = current.parent
  }
  return false
}

function editForCandidate(candidate, key, translation, sourceFile) {
  const call = translateCall(key, translation.fallback, translation.options)
  const node = findNodeByRange(sourceFile, candidate.start, candidate.end)
  if (candidate.kind === 'jsx-text') {
    return { start: candidate.start, end: candidate.end, text: `{${call}}` }
  }
  if (candidate.kind === 'jsx-expression') {
    return { start: candidate.start, end: candidate.end, text: call }
  }
  if (candidate.kind.startsWith('jsx-attribute:')) {
    if (node?.parent && ts.isJsxAttribute(node.parent) && node.parent.initializer === node) {
      return { start: node.getStart(sourceFile), end: node.getEnd(), text: `{${call}}` }
    }
    if (node && isInsideJsxExpression(node)) {
      return { start: candidate.start, end: candidate.end, text: call }
    }
    return { start: candidate.start, end: candidate.end, text: `{${call}}` }
  }
  return { start: candidate.start, end: candidate.end, text: call }
}

function sourceKindForPath(filePath) {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS
}

function findNodeByRange(sourceFile, start, end) {
  let match

  function visit(node) {
    if (node.getStart(sourceFile) === start && node.getEnd() === end) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return match
}

function translationForCandidate(candidate, sourceFile) {
  if (!candidate.dynamic) {
    return { fallback: candidate.text }
  }

  const node = findNodeByRange(sourceFile, candidate.start, candidate.end)
  if (!node || !ts.isTemplateExpression(node)) {
    return null
  }

  const options = {}
  let fallback = node.head.text
  node.templateSpans.forEach((span, index) => {
    const optionName = `value${index}`
    options[optionName] = span.expression.getText(sourceFile)
    fallback += `{{${optionName}}}${span.literal.text}`
  })

  const optionSource = `{ ${Object.entries(options)
    .map(([name, expression]) => `${name}: ${expression}`)
    .join(', ')} }`

  return { fallback, options: optionSource }
}

function hasTranslateImport(sourceText) {
  return /import\s*\{[^}]*\btranslate\b[^}]*\}\s*from\s*['"]@\/i18n\/i18n['"]/.test(sourceText)
}

function addTranslateImport(sourceText) {
  if (hasTranslateImport(sourceText)) {
    return sourceText
  }

  const importMatches = [...sourceText.matchAll(/^import[\s\S]*?from\s*['"][^'"]+['"]\n/gm)]
  if (importMatches.length === 0) {
    return `${TRANSLATE_IMPORT}${sourceText}`
  }

  const lastImport = importMatches.at(-1)
  const insertAt = (lastImport.index ?? 0) + lastImport[0].length
  return `${sourceText.slice(0, insertAt)}${TRANSLATE_IMPORT}${sourceText.slice(insertAt)}`
}

function uniqueCandidates(candidates) {
  const seen = new Set()
  const unique = []

  for (const candidate of candidates) {
    const signature = `${candidate.start}:${candidate.end}:${candidate.kind}`
    if (!seen.has(signature)) {
      seen.add(signature)
      unique.push(candidate)
    }
  }

  return unique
}

function applyReplacements(filePath, sourceText, candidates, catalog) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKindForPath(filePath)
  )
  const replacements = uniqueCandidates(candidates)
    .map((candidate) => ({
      candidate,
      translation: translationForCandidate(candidate, sourceFile)
    }))
    .filter((entry) => entry.translation !== null)
    .sort((left, right) => right.candidate.start - left.candidate.start)

  let nextSource = sourceText
  for (const { candidate, translation } of replacements) {
    const key = keyForCandidate(candidate)
    setCatalogValue(catalog, key, translation.fallback)
    const edit = editForCandidate(candidate, key, translation, sourceFile)
    nextSource = `${nextSource.slice(0, edit.start)}${edit.text}${nextSource.slice(edit.end)}`
  }

  return replacements.length > 0 ? addTranslateImport(nextSource) : nextSource
}

async function localizeFile(root, filePath, catalog) {
  const sourceText = await fs.readFile(filePath, 'utf8')
  const candidates = collectLocalizationCandidates(filePath, sourceText, root)
  if (candidates.length === 0) {
    return 0
  }
  const nextSource = applyReplacements(filePath, sourceText, candidates, catalog)
  if (nextSource !== sourceText) {
    await fs.writeFile(filePath, nextSource)
  }
  return uniqueCandidates(candidates).length
}

async function collectCandidateFiles(root) {
  const sourceRoot = path.join(root, 'src', 'renderer', 'src')
  const reports = []
  const stack = [sourceRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (
          !['.git', 'assets', 'dist', 'node_modules', 'out', '__snapshots__'].includes(entry.name)
        ) {
          stack.push(fullPath)
        }
        continue
      }
      if (
        entry.isFile() &&
        /\.(?:ts|tsx|js|jsx|mts|cts)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.includes('.test.') &&
        !entry.name.includes('.spec.')
      ) {
        reports.push(fullPath)
      }
    }
  }
  return reports
}

export async function main(root = process.cwd()) {
  const catalogPath = path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales', 'en.json')
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const files = await collectCandidateFiles(root)
  let count = 0

  for (const filePath of files) {
    count += await localizeFile(root, filePath, catalog)
  }

  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`Localized ${count} renderer string candidates.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
