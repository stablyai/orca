import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript-api'
import { pathToFileURL } from 'node:url'
import {
  parseCountBaseline,
  parseCountNotes,
  readTrackedSources,
  runCountRatchet
} from '../../ratchet-baseline/ratchet-baseline.mjs'

// Ratchet raw whole-workspace reads of terminals and pages downward: on a shared agent each person
// has their own tab list, and a read over every record mixes theirs into the host's.

const BASELINE_PATH = 'config/raw-tab-list-read-baseline.txt'
// The runtime owns the PTY records and the page registry; elsewhere `everyPage` is another API's.
const SCAN_ROOTS = ['src/main/runtime', 'src/main/orcad']
const FIX =
  "use pagesOf / ptyInList for a person's tabs; whole-workspace reads need an allow-list entry with a reason"
// The runtime's PTY record map under every name it travels by: `ptysById` (and its backing
// `terminalIdentity.ptys`), a `ptys` source handed to a reader, and the `getPtys()` iterable.
const PTY_MAP_NAMES = new Set(['ptysById', 'ptys'])
const PTY_MAP_GETTERS = new Set(['getPtys', 'ptys'])
const ITERATING_METHODS = new Set(['values', 'entries', 'keys', 'forEach'])
// Calls that read a whole map they are handed.
const WHOLE_READERS = new Set([
  'Array.from',
  'Object.fromEntries',
  'Object.entries',
  'Object.values'
])

export function isScannedPath(rel) {
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(?:^|[/.-])(?:test-fixture|test-support|test-harness|fixtures?)(?:[/.-]|$)|__fixtures__/.test(
      rel
    )
  )
}

/** `a.b`, `a?.b`, `(a)`, `a!`, `a as T`, `a ?? b` (its left side) all read `a`. */
function unwrap(node) {
  let current = node
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression
    } else if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      current = current.left
    } else {
      return current
    }
  }
}

function calleeName(expression) {
  const callee = unwrap(expression)
  if (ts.isIdentifier(callee)) {
    return callee.text
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const owner = unwrap(callee.expression)
    return ts.isIdentifier(owner) ? `${owner.text}.${callee.name.text}` : callee.name.text
  }
  return null
}

/** Counts raw whole-map reads in one file: every registry `everyPage` call (however it is reached),
 *  and every iteration, size read, copy or spread of the PTY map, under any name it travels by. */
export function countRawTabListReads(sourceText, fileName = 'file.ts') {
  if (!/everyPage|ptys/i.test(sourceText)) {
    return 0
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  // Local names a map is copied into (`const m = this.ptysById`, `const { ptysById } = this`).
  const aliases = new Set()
  const everyPageAliases = new Set()
  const isPtyMap = (node) => {
    const value = unwrap(node)
    if (ts.isConditionalExpression(value)) {
      return isPtyMap(value.whenTrue) || isPtyMap(value.whenFalse)
    }
    if (ts.isIdentifier(value)) {
      return PTY_MAP_NAMES.has(value.text) || aliases.has(value.text)
    }
    if (ts.isPropertyAccessExpression(value)) {
      return PTY_MAP_NAMES.has(value.name.text)
    }
    if (ts.isCallExpression(value)) {
      const name = calleeName(value.expression)
      return name !== null && PTY_MAP_GETTERS.has(name.split('.').pop())
    }
    return false
  }
  const collectAliases = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isPtyMap(node.initializer)) {
        aliases.add(node.name.text)
      }
      const initial = unwrap(node.initializer)
      if (
        ts.isIdentifier(node.name) &&
        ts.isPropertyAccessExpression(initial) &&
        initial.name.text === 'everyPage'
      ) {
        everyPageAliases.add(node.name.text)
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name
          if (ts.isIdentifier(key) && ts.isIdentifier(element.name)) {
            if (PTY_MAP_NAMES.has(key.text)) {
              aliases.add(element.name.text)
            }
            if (key.text === 'everyPage') {
              everyPageAliases.add(element.name.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(sourceFile)
  let count = 0
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      const name = calleeName(node.expression)
      if (
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'everyPage') ||
        (ts.isIdentifier(callee) &&
          (callee.text === 'everyPage' || everyPageAliases.has(callee.text)))
      ) {
        count += 1
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ITERATING_METHODS.has(callee.name.text) &&
        isPtyMap(callee.expression)
      ) {
        count += 1
      } else if (
        name !== null &&
        WHOLE_READERS.has(name) &&
        node.arguments[0] &&
        isPtyMap(node.arguments[0])
      ) {
        count += 1
      } else if (
        ts.isElementAccessExpression(callee) &&
        isPtyMap(callee.expression) &&
        callee.argumentExpression.getText(sourceFile) === 'Symbol.iterator'
      ) {
        count += 1
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'Map' || node.expression.text === 'Set') &&
      node.arguments?.[0] &&
      isPtyMap(node.arguments[0])
    ) {
      count += 1
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      isPtyMap(node.initializer)
    ) {
      count += 1
    } else if (ts.isForOfStatement(node) && isPtyMap(node.expression)) {
      count += 1
    } else if (ts.isSpreadElement(node) && isPtyMap(node.expression)) {
      count += 1
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'size' &&
      isPtyMap(node.expression)
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

export function collectRawTabListReadCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countRawTabListReads(source, rel)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

/** Every allowed file says why it reads the whole workspace. */
export function unexplainedRows(text) {
  const notes = parseCountNotes(text)
  return [...parseCountBaseline(text).keys()].filter((file) => !notes.has(file))
}

export function main(root = process.cwd(), arg = undefined) {
  const baselineFile = path.join(root, BASELINE_PATH)
  const unexplained = fs.existsSync(baselineFile)
    ? unexplainedRows(fs.readFileSync(baselineFile, 'utf8'))
    : []
  for (const file of unexplained) {
    console.error(`${BASELINE_PATH}: ${file} has no '# why'. ${FIX}.`)
  }
  const status = runCountRatchet(
    {
      name: 'raw-tab-list-read',
      baselinePath: BASELINE_PATH,
      header: [
        '# Raw reads over every terminal or page per file: registry everyPage(...) calls, and iterations,',
        '# size reads, copies or spreads of the PTY map under any name it travels by (ptysById,',
        '# terminalIdentity.ptys, a `ptys` source, getPtys()). This is a RATCHET: counts may only go DOWN.',
        "# A person's tabs read through pagesOf / ptyInList. A whole-workspace read (teardown, removal,",
        '# census, lookup by id) needs a row here: count, file, and a trailing # why.',
        '# Prune after a fix: pnpm check:raw-tab-list-read-ratchet --prune'
      ],
      collect: collectRawTabListReadCounts,
      unit: 'raw tab list read(s)',
      fix: [`${FIX}.`]
    },
    root,
    arg
  )
  return unexplained.length > 0 && arg !== '--prune' ? 1 : status
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
