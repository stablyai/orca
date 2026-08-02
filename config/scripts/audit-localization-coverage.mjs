import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['.git', 'dist', 'node_modules', 'out', '__snapshots__', 'assets'])
const LOCALIZATION_CALL_NAMES = new Set(['t', 'translate'])
const USER_VISIBLE_JSX_ATTRIBUTES = new Set([
  'ariaLabel',
  'aria-label',
  'aria-description',
  'alt',
  'description',
  'emptyText',
  'helperText',
  'keywords',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'text',
  'title',
  'toggleDescription',
  'tooltip'
])
const USER_VISIBLE_OBJECT_KEYS = new Set([
  'ariaLabel',
  'badge',
  'description',
  'emptyText',
  'error',
  'helperText',
  'keywords',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title',
  'toggleDescription',
  'tooltip'
])
const USER_VISIBLE_FUNCTION_NAMES = new Set([
  'alert',
  'confirm',
  'prompt',
  'showError',
  'showToast'
])
const USER_VISIBLE_OBJECT_METHODS = new Set([
  'error',
  'info',
  'loading',
  'message',
  'promise',
  'success',
  'warning'
])
const USER_VISIBLE_OBJECT_NAMES = new Set(['toast'])

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

function hasHumanLanguageText(text) {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length < 2) {
    return false
  }
  if (/^[\d\s!-/:-@[-`{-~]+$/.test(trimmed)) {
    return false
  }
  return /[A-Za-z\u00C0-\u024F\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(trimmed)
}

function compactText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: position.line + 1, column: position.character + 1 }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return undefined
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

function stringParts(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ text: node.text, dynamic: false }]
  }
  if (!ts.isTemplateExpression(node)) {
    return []
  }
  return [
    { text: node.head.text, dynamic: true },
    ...node.templateSpans.map((span) => ({ text: span.literal.text, dynamic: true }))
  ]
}

function isInsideLocalizationCall(node) {
  let current = node.parent
  while (current) {
    if (ts.isCallExpression(current)) {
      const name = expressionNameText(current.expression)
      if (name && LOCALIZATION_CALL_NAMES.has(name.split('.').at(-1) ?? name)) {
        return true
      }
    }
    current = current.parent
  }
  return false
}

function isJsxAttributeValue(node) {
  const parent = node.parent
  if (!parent) {
    return undefined
  }
  if (ts.isJsxAttribute(parent)) {
    return propertyNameText(parent.name)
  }
  if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
    return propertyNameText(parent.parent.name)
  }
  return undefined
}

function ancestorJsxAttributeName(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxAttribute(current)) {
      return propertyNameText(current.name)
    }
    if (
      ts.isJsxExpression(current) ||
      ts.isConditionalExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isBinaryExpression(current)
    ) {
      current = current.parent
      continue
    }
    return undefined
  }
  return undefined
}

function isRenderedJsxExpression(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxExpression(current)) {
      return (
        ts.isJsxElement(current.parent) ||
        ts.isJsxFragment(current.parent) ||
        ts.isJsxSelfClosingElement(current.parent)
      )
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTemplateExpression(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      if (ts.isConditionalExpression(current) && current.condition === node) {
        return false
      }
      current = current.parent
      continue
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
        return false
      }
      current = current.parent
      continue
    }
    return false
  }
  return false
}

function nearestObjectPropertyName(node) {
  let current = node.parent
  while (current) {
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      return propertyNameText(current.name)
    }
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      current = current.parent
      continue
    }
    return undefined
  }
  return undefined
}

function hasAncestorObjectPropertyName(node, names) {
  let current = node.parent
  while (current) {
    if (
      (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) &&
      names.has(propertyNameText(current.name) ?? '')
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function nearestAncestorObjectPropertyName(node) {
  let current = node.parent
  while (current) {
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      return propertyNameText(current.name)
    }
    current = current.parent
  }
  return undefined
}

function findAncestor(node, predicate) {
  let current = node.parent
  while (current) {
    if (predicate(current)) {
      return current
    }
    current = current.parent
  }
  return undefined
}

function isUserVisibleCallArgument(node) {
  const call = findAncestor(node, ts.isCallExpression)
  if (!call) {
    return false
  }
  const expressionName = expressionNameText(call.expression)
  if (!expressionName) {
    return false
  }
  const parts = expressionName.split('.')
  const methodName = parts.at(-1)
  const objectName = parts.at(-2)
  return (
    USER_VISIBLE_FUNCTION_NAMES.has(expressionName) ||
    USER_VISIBLE_FUNCTION_NAMES.has(methodName ?? '') ||
    (objectName !== undefined &&
      USER_VISIBLE_OBJECT_NAMES.has(objectName) &&
      USER_VISIBLE_OBJECT_METHODS.has(methodName ?? ''))
  )
}

function classifyStringNode(node) {
  if (hasAncestorObjectPropertyName(node, new Set(['className', 'classNames']))) {
    return undefined
  }

  if (
    findAncestor(
      node,
      (ancestor) =>
        ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind !== ts.SyntaxKind.PlusToken
    )
  ) {
    return undefined
  }

  const jsxAttributeName = isJsxAttributeValue(node)
  if (jsxAttributeName) {
    return USER_VISIBLE_JSX_ATTRIBUTES.has(jsxAttributeName)
      ? `jsx-attribute:${jsxAttributeName}`
      : undefined
  }

  const ancestorAttributeName = ancestorJsxAttributeName(node)
  if (ancestorAttributeName) {
    return USER_VISIBLE_JSX_ATTRIBUTES.has(ancestorAttributeName)
      ? `jsx-attribute:${ancestorAttributeName}`
      : undefined
  }

  if (ts.isJsxText(node)) {
    return 'jsx-text'
  }

  const objectPropertyName = nearestObjectPropertyName(node)
  if (objectPropertyName && !USER_VISIBLE_OBJECT_KEYS.has(objectPropertyName)) {
    return undefined
  }

  const ancestorObjectPropertyName = nearestAncestorObjectPropertyName(node)
  if (ancestorObjectPropertyName && !USER_VISIBLE_OBJECT_KEYS.has(ancestorObjectPropertyName)) {
    return undefined
  }

  if (isRenderedJsxExpression(node)) {
    return 'jsx-expression'
  }

  if (isUserVisibleCallArgument(node)) {
    return 'user-visible-call'
  }

  if (objectPropertyName) {
    return `object-property:${objectPropertyName}`
  }

  return undefined
}

function areaForFile(relativePath) {
  const rendererPrefix = 'src/renderer/src/'
  if (!relativePath.startsWith(rendererPrefix)) {
    return relativePath.split('/').slice(0, 2).join('/')
  }

  const withoutPrefix = relativePath.slice(rendererPrefix.length)
  const parts = withoutPrefix.split('/')
  if (parts[0] === 'components' && parts[1]) {
    return `renderer/${parts[1]}`
  }
  return `renderer/${parts[0] ?? 'root'}`
}

export function collectLocalizationCandidates(filePath, sourceText, root = process.cwd()) {
  const sourceKind =
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const reports = []
  const relativePath = normalizePath(root, filePath)

  function pushReport(node, kind, text, dynamic = false) {
    const value = compactText(text)
    if (!hasHumanLanguageText(value) || isInsideLocalizationCall(node)) {
      return
    }
    const position = lineAndColumn(sourceFile, node)
    reports.push({
      area: areaForFile(relativePath),
      filePath: relativePath,
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      line: position.line,
      column: position.column,
      kind,
      text: value,
      dynamic
    })
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      pushReport(node, 'jsx-text', node.text)
      return
    }

    const kind = classifyStringNode(node)
    if (kind) {
      for (const part of stringParts(node)) {
        pushReport(node, kind, part.text, part.dynamic)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return reports
}

function groupByArea(reports) {
  const groups = new Map()
  for (const report of reports) {
    const group = groups.get(report.area) ?? { area: report.area, count: 0, files: new Map() }
    group.count += 1
    group.files.set(report.filePath, (group.files.get(report.filePath) ?? 0) + 1)
    groups.set(report.area, group)
  }
  return [...groups.values()].sort((left, right) => right.count - left.count)
}

function formatReports(_root, reports) {
  return reports
    .map(
      (report) =>
        `${report.filePath}:${report.line}:${report.column} ${report.kind}: ${JSON.stringify(report.text)}`
    )
    .join('\n')
}

function formatMarkdownReport(reports) {
  const groups = groupByArea(reports)
  const lines = [
    '# Localization Candidate Inventory',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Total candidates: ${reports.length}`,
    '',
    '## Area Summary',
    ''
  ]

  for (const group of groups) {
    lines.push(`- ${group.area}: ${group.count} candidates across ${group.files.size} files`)
  }

  lines.push('', '## Candidates', '')
  for (const group of groups) {
    lines.push(`### ${group.area}`, '')
    for (const report of reports.filter((entry) => entry.area === group.area)) {
      lines.push(
        `- \`${report.filePath}:${report.line}:${report.column}\` ${report.kind}: ${JSON.stringify(report.text)}`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

function parseArgs(argv) {
  const options = {
    allowlistPath: path.join('config', 'localization-coverage-allowlist.json'),
    check: false,
    format: 'summary',
    outputPath: null,
    sourceRoot: path.join('src', 'renderer', 'src')
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.format = 'json'
    } else if (arg === '--markdown') {
      options.format = 'markdown'
    } else if (arg === '--check') {
      options.check = true
    } else if (arg === '--allowlist') {
      options.allowlistPath = argv[index + 1] ?? options.allowlistPath
      index += 1
    } else if (arg === '--output') {
      options.outputPath = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--source-root') {
      options.sourceRoot = argv[index + 1] ?? options.sourceRoot
      index += 1
    }
  }

  return options
}

function candidateSignature(candidate) {
  return JSON.stringify({
    filePath: candidate.filePath,
    kind: candidate.kind,
    text: candidate.text,
    dynamic: candidate.dynamic
  })
}

function countBySignature(reports) {
  const counts = new Map()
  for (const report of reports) {
    const signature = candidateSignature(report)
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return counts
}

async function readAllowlist(root, allowlistPath) {
  const absolutePath = path.resolve(root, allowlistPath)
  const raw = await fs.readFile(absolutePath, 'utf8')
  return JSON.parse(raw)
}

function findNewCandidates(reports, allowlist) {
  const allowedCounts = new Map(
    allowlist.map((entry) => [
      JSON.stringify({
        filePath: entry.filePath,
        kind: entry.kind,
        text: entry.text,
        dynamic: entry.dynamic
      }),
      entry.count
    ])
  )
  const seenCounts = countBySignature(reports)
  const newCandidates = []

  for (const report of reports) {
    const signature = candidateSignature(report)
    const seenCount = seenCounts.get(signature) ?? 0
    const allowedCount = allowedCounts.get(signature) ?? 0
    if (seenCount > allowedCount) {
      newCandidates.push(report)
      seenCounts.set(signature, seenCount - 1)
    }
  }

  return newCandidates
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const absoluteSourceRoot = path.resolve(root, options.sourceRoot)
  const files = await collectSourceFiles(root, absoluteSourceRoot)
  const reports = []

  for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, 'utf8')
    reports.push(...collectLocalizationCandidates(filePath, sourceText, root))
  }

  if (options.check) {
    const allowlist = await readAllowlist(root, options.allowlistPath)
    const newCandidates = findNewCandidates(reports, allowlist)
    if (newCandidates.length > 0) {
      console.error('New unlocalized renderer strings were found.')
      console.error('Localize them or add a reviewed exclusion to the localization allowlist.')
      console.error('')
      console.error(formatReports(root, newCandidates))
      return 1
    }
    console.log(`Localization coverage check passed with ${reports.length} allowlisted candidates.`)
    return 0
  }

  const output =
    options.format === 'json'
      ? `${JSON.stringify(reports, null, 2)}\n`
      : options.format === 'markdown'
        ? `${formatMarkdownReport(reports)}\n`
        : `${reports.length} localization candidates in ${files.length} files.\n${groupByArea(
            reports
          )
            .map((group) => `${group.area}: ${group.count}`)
            .join('\n')}\n`

  if (options.outputPath) {
    await fs.mkdir(path.dirname(path.resolve(root, options.outputPath)), { recursive: true })
    await fs.writeFile(path.resolve(root, options.outputPath), output)
  } else {
    process.stdout.write(output)
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
