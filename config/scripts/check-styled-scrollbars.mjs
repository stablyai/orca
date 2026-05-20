import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['node_modules', 'dist', 'out', '.git', '__snapshots__'])
const STYLED_SCROLLBAR_CLASSES = new Set([
  'scrollbar-sleek',
  'scrollbar-editor',
  'scrollbar-none',
  'worktree-sidebar-scrollbar'
])
// Why: vertical scrolling is where Orca's native scrollbar drift keeps showing
// up in cards, dialogs, and menus; horizontal code/table overflow is handled separately.
const VERTICAL_SCROLL_CLASSES = new Set([
  'overflow-auto',
  'overflow-scroll',
  'overflow-y-auto',
  'overflow-y-scroll'
])

export function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function isSkippedFile(root, filePath) {
  const relative = normalizePath(root, filePath)
  if (relative.includes('.test.') || relative.includes('.spec.')) {
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
    if (!entry.isFile() || isSkippedFile(root, fullPath)) {
      continue
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }

  return files
}

export function plainClassName(token) {
  const withoutImportant = token.startsWith('!') ? token.slice(1) : token
  const variantSeparator = withoutImportant.lastIndexOf(':')
  return variantSeparator === -1 ? withoutImportant : withoutImportant.slice(variantSeparator + 1)
}

function hasVerticalScrollClass(text) {
  return text.split(/\s+/).some((token) => VERTICAL_SCROLL_CLASSES.has(plainClassName(token)))
}

function hasStyledScrollbarClass(text) {
  return text.split(/\s+/).some((token) => STYLED_SCROLLBAR_CLASSES.has(plainClassName(token)))
}

function lineAndColumnForPosition(sourceText, position) {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < position; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: position - lineStart + 1 }
}

function stringFragments(node) {
  if (ts.isStringLiteralLike(node)) {
    return [node.text]
  }
  if (!ts.isTemplateExpression(node)) {
    return []
  }
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
}

export function reportUnstyledScrollbars(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const reports = []

  function visit(node) {
    const fragments = stringFragments(node)
    if (fragments.some(hasVerticalScrollClass) && !fragments.some(hasStyledScrollbarClass)) {
      const { line, column } = lineAndColumnForPosition(sourceText, node.getStart(sourceFile))
      reports.push({ filePath, line, column, text: fragments.join('${...}').trim() })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return reports
}

export async function collectUnstyledScrollbarReports(root = process.cwd()) {
  const scanRoot = path.join(root, 'src', 'renderer', 'src')
  const files = await collectSourceFiles(root, scanRoot)
  const reports = []

  for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, 'utf8')
    reports.push(...reportUnstyledScrollbars(filePath, sourceText))
  }

  return reports
}

export function formatReports(root, reports) {
  return reports
    .map(
      (report) =>
        `${normalizePath(root, report.filePath)}:${report.line}:${report.column} ${report.text.replace(/\s+/g, ' ')}`
    )
    .join('\n')
}

export async function main(root = process.cwd()) {
  const reports = await collectUnstyledScrollbarReports(root)
  if (reports.length === 0) {
    return 0
  }

  console.error('Renderer vertical scroll containers must use an Orca scrollbar style.')
  console.error(
    'Add scrollbar-sleek, scrollbar-editor, scrollbar-none, or use the shadcn ScrollArea wrapper.'
  )
  console.error('')
  console.error(formatReports(root, reports))
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
