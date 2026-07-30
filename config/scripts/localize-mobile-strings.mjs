import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import ts from 'typescript-api'

import { collectLocalizationCandidates } from './audit-localization-coverage.mjs'

const TRANSLATE_IMPORT = "import { t } from '@/i18n/mobile-i18n'\n"
const JSX_ENTITY_VALUES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

function decodeJsxEntities(value) {
  return value.replace(/&(amp|apos|gt|lt|quot);/g, (_match, name) => JSX_ENTITY_VALUES[name])
}

function keyForCandidate(candidate, fallback = candidate.text) {
  const source = `${candidate.filePath}:${fallback}`
  const hash = createHash('sha1').update(source).digest().subarray(0, 5).toString('base64url')
  return `m.${hash}`
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

function translateCall(key, _value, options) {
  if (options) {
    return `t(${JSON.stringify(key)}, ${options})`
  }
  return `t(${JSON.stringify(key)})`
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
    return { fallback: decodeJsxEntities(candidate.text) }
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
  return /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"]@\/i18n\/mobile-i18n['"]/.test(sourceText)
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

function hasJsxDescendant(node) {
  let found = false
  function visit(child) {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

function mixedJsxTranslation(node, filePath, sourceFile) {
  if (
    !ts.isJsxElement(node) ||
    node.children.some(
      (child) =>
        ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)
    )
  ) {
    return null
  }

  const options = []
  let sourceFallback = ''
  let hasText = false
  let hasValue = false
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      sourceFallback += child.text
      hasText ||= /[A-Za-z\u00C0-\u024F\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(child.text)
      continue
    }
    if (!ts.isJsxExpression(child) || !child.expression) {
      continue
    }
    const expression = child.expression
    if (ts.isStringLiteralLike(expression)) {
      sourceFallback += expression.text
      hasText ||= /[A-Za-z\u00C0-\u024F\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(
        expression.text
      )
      continue
    }
    if (hasJsxDescendant(expression)) {
      return null
    }
    const optionName = `value${options.length}`
    sourceFallback += `{{${optionName}}}`
    options.push([optionName, expression.getText(sourceFile)])
    hasValue = true
  }

  const fallback = decodeJsxEntities(sourceFallback.replace(/\s+/g, ' ').trim())
  if (!hasText || !hasValue || fallback.length < 2) {
    return null
  }
  const optionsSource = `{ ${options
    .map(([name, expression]) => `${name}: ${expression}`)
    .join(', ')} }`
  const key = keyForCandidate({ filePath, text: fallback })
  return {
    key,
    fallback,
    start: node.openingElement.getEnd(),
    end: node.closingElement.getStart(sourceFile),
    text: `{${translateCall(key, fallback, optionsSource)}}`
  }
}

function collectMixedJsxTranslations(filePath, sourceFile) {
  const translations = []
  function visit(node) {
    const translation = mixedJsxTranslation(node, filePath, sourceFile)
    if (translation) {
      translations.push(translation)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return translations
}

function applyReplacements(filePath, sourceText, candidates, catalog) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKindForPath(filePath)
  )
  const mixedTranslations = collectMixedJsxTranslations(filePath, sourceFile)
  const unique = uniqueCandidates(candidates)
  const replacements = unique
    .filter(
      (candidate) =>
        !mixedTranslations.some(
          (translation) => candidate.start >= translation.start && candidate.end <= translation.end
        ) &&
        !unique.some(
          (other) =>
            other !== candidate &&
            other.start <= candidate.start &&
            other.end >= candidate.end &&
            (other.start < candidate.start || other.end > candidate.end)
        )
    )
    .map((candidate) => ({
      candidate,
      translation: translationForCandidate(candidate, sourceFile)
    }))
    .filter((entry) => entry.translation !== null)
    .sort((left, right) => right.candidate.start - left.candidate.start)

  const edits = []
  for (const { candidate, translation } of replacements) {
    const key = keyForCandidate(candidate, translation.fallback)
    setCatalogValue(catalog, key, translation.fallback)
    const edit = editForCandidate(candidate, key, translation, sourceFile)
    edits.push(edit)
  }
  for (const translation of mixedTranslations) {
    setCatalogValue(catalog, translation.key, translation.fallback)
    edits.push(translation)
  }

  let nextSource = sourceText
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    nextSource = `${nextSource.slice(0, edit.start)}${edit.text}${nextSource.slice(edit.end)}`
  }

  return edits.length > 0 ? addTranslateImport(nextSource) : nextSource
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
  const reports = []
  const stack = [path.join(root, 'mobile', 'app'), path.join(root, 'mobile', 'src')]
  while (stack.length > 0) {
    const dir = stack.pop()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['assets', 'i18n', 'node_modules'].includes(entry.name)) {
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
  const catalogPath = path.join(root, 'mobile', 'src', 'i18n', 'locales', 'en.json')
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const files = await collectCandidateFiles(root)
  let count = 0

  for (const filePath of files) {
    count += await localizeFile(root, filePath, catalog)
  }

  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`Localized ${count} mobile string candidates.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
