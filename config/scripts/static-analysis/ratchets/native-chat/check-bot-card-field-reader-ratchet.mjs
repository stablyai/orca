import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'

// Clients read a chat card only through the shared readers (nativeChatBotCardOf,
// nativeChatBotMessageCardOf), so a new card can't reach one platform and not the other.

const BASELINE_PATH = 'config/bot-card-field-reader-baseline.txt'
const FIELDS_PATH = 'src/shared/native-chat/bot-cards/native-chat-bot-card-fields.ts'
// The declarations whose properties are the guarded card fields.
const FIELD_TYPES = ['NativeChatBotCardFieldValues', 'NativeChatBotMessageCardFieldValues']
const SCAN_ROOTS = ['src/renderer/src', 'mobile/src']
const HEADER = [
  '# Direct reads of a chat card field (block.botRequest, message.toolAdded, ...) per client file.',
  '# This is a RATCHET: counts may only go DOWN. Read cards with nativeChatBotCardOf or',
  '# nativeChatBotMessageCardOf (src/shared/native-chat/bot-cards/native-chat-bot-card-kind.ts).',
  '# Prune after a fix: pnpm check:bot-card-field-reader-ratchet --prune'
]

/** The guarded field names, read from their declaration so a new field is guarded at once. */
export function readCardFields(root = process.cwd()) {
  const file = path.join(root, FIELDS_PATH)
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const fields = new Set()
  for (const statement of source.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      FIELD_TYPES.includes(statement.name.text) &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      for (const member of statement.type.members) {
        if (member.name && ts.isIdentifier(member.name)) {
          fields.add(member.name.text)
        }
      }
    }
  }
  if (fields.size === 0) {
    throw new Error(`No card fields found in ${FIELDS_PATH} (${FIELD_TYPES.join(', ')}).`)
  }
  return fields
}

function isScannedPath(rel) {
  return (
    SCAN_ROOTS.some((root) => rel.startsWith(`${root}/`)) &&
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(?:^|[/.-])(?:test-fixture|test-support|test-harness|fixtures?)(?:[/.-]|$)|__fixtures__/.test(
      rel
    )
  )
}

// `window.api.googleSetup` is the preload bridge, not a card.
function isPreloadBridge(expression) {
  return ts.isIdentifier(expression)
    ? expression.text === 'api'
    : ts.isPropertyAccessExpression(expression) && expression.name.text === 'api'
}

function stringLiteralText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null
}

// A property name as written: `f`, `'f'` or a literal computed `['f']`.
function propertyKey(name) {
  if (!name) {
    return null
  }
  if (ts.isComputedPropertyName(name)) {
    return stringLiteralText(name.expression)
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null
}

function bindingKey(element) {
  return propertyKey(element.propertyName ?? element.name)
}

// An object literal that is the target of `=` or a for-of/for-in head, possibly nested.
function isDestructuringTarget(objectLiteral) {
  let child = objectLiteral
  let parent = objectLiteral.parent
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === child))
  ) {
    child = parent
    parent = parent.parent
  }
  if (!parent) {
    return false
  }
  if (ts.isBinaryExpression(parent)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === child
  }
  return (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child
  )
}

function assignmentKey(property) {
  if (!ts.isObjectLiteralExpression(property.parent) || !isDestructuringTarget(property.parent)) {
    return null
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text
  }
  return ts.isPropertyAssignment(property) ? propertyKey(property.name) : null
}

/** Reads of a card field: `x.f`, `x?.f`, `x['f']`, `const { f } = x`, `({ f: v } = x)` and `'f' in x`. */
export function countCardFieldReads(fileName, text, fields) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  let count = 0
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      fields.has(node.name.text) &&
      !isPreloadBridge(node.expression)
    ) {
      count += 1
    } else if (
      ts.isElementAccessExpression(node) &&
      fields.has(stringLiteralText(node.argumentExpression))
    ) {
      count += 1
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      fields.has(bindingKey(node))
    ) {
      count += 1
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      fields.has(assignmentKey(node))
    ) {
      count += 1
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      fields.has(stringLiteralText(node.left))
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

export function collectBotCardFieldReads(root = process.cwd()) {
  const fields = readCardFields(root)
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countCardFieldReads(rel, source, fields)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'bot-card-field-reader',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectBotCardFieldReads,
      unit: 'direct card field read(s)',
      fix: [
        'Read the card with nativeChatBotCardOf or nativeChatBotMessageCardOf (src/shared/native-chat/bot-cards/native-chat-bot-card-kind.ts).'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
