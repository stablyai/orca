import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['node_modules', 'dist', 'out', '.git', '__snapshots__'])
const SCAN_ROOTS = ['src', 'config/scripts', 'tools', 'tests', 'mobile']

const LOOP_KINDS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement
])

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken
])

function normalizeReferenceText(text) {
  return text.replaceAll(/\s+/g, '')
}

// The variable a member/call chain ultimately reads, so `carry.subarray(0, n)`
// still resolves to `carry`. `this.x` stops at the property: the class field is
// the accumulator.
function rootReferenceText(node) {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.expression.kind === ts.SyntaxKind.ThisKeyword
      ? normalizeReferenceText(node.getText())
      : rootReferenceText(node.expression)
  }
  if (
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node)
  ) {
    return rootReferenceText(node.expression)
  }
  return undefined
}

function isBufferConcatCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'concat' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Buffer' &&
    node.arguments.length > 0 &&
    ts.isArrayLiteralExpression(node.arguments[0])
  )
}

function enclosingLoop(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (LOOP_KINDS.has(current.kind)) {
      return current
    }
  }
  return undefined
}

// A `for (let acc = ...; ;)` binding is loop-carried even though it sits inside
// the loop node, so the initializer does not count as loop-local.
function isDeclaredInsideLoop(declarationStart, loop) {
  if (declarationStart < loop.getStart() || declarationStart >= loop.end) {
    return false
  }
  const initializer = ts.isForStatement(loop) ? loop.initializer : undefined
  if (!initializer) {
    return true
  }
  return declarationStart < initializer.getStart() || declarationStart >= initializer.end
}

function collectBindingNames(name, into) {
  if (ts.isIdentifier(name)) {
    into.push(name)
    return
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, into)
      }
    }
  }
}

function collectDeclarations(sourceFile) {
  const declarations = new Map()
  const record = (identifier, node) => {
    const existing = declarations.get(identifier.text)
    const start = node.getStart(sourceFile)
    if (existing) {
      existing.push(start)
    } else {
      declarations.set(identifier.text, [start])
    }
  }

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      const names = []
      collectBindingNames(node.name, names)
      for (const identifier of names) {
        record(identifier, node)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return declarations
}

function collectAssignedRoots(loop) {
  const assigned = new Set()
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      const root = rootReferenceText(node.left)
      if (root) {
        assigned.add(root)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(loop.statement)
  return assigned
}

// Unwrap the wrappers a concat result passes through before it lands on the
// left-hand side, so `acc = cond ? Buffer.concat([acc, c]) : c` still counts.
function assignmentTargetOf(call) {
  let node = call
  let parent = node.parent
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== node))
  ) {
    node = parent
    parent = parent.parent
  }
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    return {
      text: normalizeReferenceText(parent.left.getText()),
      root: rootReferenceText(parent.left)
    }
  }
  return undefined
}

function concatOperands(call) {
  return call.arguments[0].elements.map((element) => {
    const spread = ts.isSpreadElement(element)
    const expression = spread ? element.expression : element
    return {
      spread,
      text: normalizeReferenceText(expression.getText()),
      root: rootReferenceText(expression)
    }
  })
}

// A binding reset on every iteration cannot accumulate; only one that outlives
// the iteration carries the cost forward.
function isLoopCarried(root, loop, declarations) {
  const starts = declarations.get(root)
  if (!starts) {
    return true
  }
  return !starts.some((start) => isDeclaredInsideLoop(start, loop))
}

function quadraticAccumulator(call, loop, declarations, assignedRoots) {
  const operands = concatOperands(call)
  const target = assignmentTargetOf(call)
  // The result feeds straight back into its own input: every iteration re-copies
  // everything accumulated so far.
  const selfOperand = target
    ? operands.find((operand) => operand.text === target.text || operand.root === target.root)
    : undefined
  if (selfOperand && target.root && isLoopCarried(target.root, loop, declarations)) {
    return target.text
  }

  // No direct self-assignment, so look for a loop-carried operand reassigned
  // inside the loop: the concat result reaches it by some other path. Spread
  // operands are the sanctioned chunk-list fix, not this bug, so skip them.
  for (const operand of operands) {
    if (operand.spread || !operand.root || !assignedRoots.has(operand.root)) {
      continue
    }
    if (isLoopCarried(operand.root, loop, declarations)) {
      return operand.root
    }
  }
  return undefined
}

export function reportQuadraticBufferConcat(filePath, sourceText) {
  if (!sourceText.includes('Buffer.concat')) {
    return []
  }
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
  const declarations = collectDeclarations(sourceFile)
  const assignedRootsByLoop = new Map()
  const reports = []
  const seen = new Set()

  const visit = (node) => {
    if (isBufferConcatCall(node)) {
      const loop = enclosingLoop(node)
      if (loop) {
        let assignedRoots = assignedRootsByLoop.get(loop)
        if (!assignedRoots) {
          assignedRoots = collectAssignedRoots(loop)
          assignedRootsByLoop.set(loop, assignedRoots)
        }
        const accumulator = quadraticAccumulator(node, loop, declarations, assignedRoots)
        if (accumulator) {
          const start = node.getStart(sourceFile)
          if (!seen.has(start)) {
            seen.add(start)
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
            reports.push({
              filePath,
              line: line + 1,
              column: character + 1,
              accumulator,
              text: node.getText()
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return reports
}

export function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function isSkippedFile(root, filePath) {
  const relative = normalizePath(root, filePath)
  // Benchmarks keep the pre-fix shape on purpose so they can measure against it.
  if (
    relative.includes('.test.') ||
    relative.includes('.spec.') ||
    relative.includes('-benchmark.')
  ) {
    return true
  }
  return relative.split('/').some((part) => SKIP_PATH_PARTS.has(part))
}

async function collectSourceFiles(root, dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_PATH_PARTS.has(entry.name)) {
        files.push(...(await collectSourceFiles(root, fullPath)))
      }
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !isSkippedFile(root, fullPath)
    ) {
      files.push(fullPath)
    }
  }

  return files
}

function formatReports(root, reports) {
  return reports
    .map(
      (report) =>
        `${normalizePath(root, report.filePath)}:${report.line}:${report.column} ${report.accumulator} — ${report.text.replaceAll(/\s+/g, ' ')}`
    )
    .join('\n')
}

export async function main(root = process.cwd()) {
  const reports = []
  for (const scanRoot of SCAN_ROOTS) {
    const files = await collectSourceFiles(root, path.join(root, scanRoot))
    for (const filePath of files) {
      const sourceText = await fs.readFile(filePath, 'utf8')
      reports.push(...reportQuadraticBufferConcat(filePath, sourceText))
    }
  }
  if (reports.length === 0) {
    return 0
  }

  console.error('Buffer.concat must not rebuild a loop-carried accumulator.')
  console.error('Each iteration re-copies everything accumulated so far, so the loop is O(n^2).')
  console.error('Collect the pieces in a Buffer[] and Buffer.concat(chunks) once, after the loop.')
  console.error('')
  console.error(formatReports(root, reports))
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
