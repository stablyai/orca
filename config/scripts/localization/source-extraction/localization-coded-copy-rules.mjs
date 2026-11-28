// Coverage rules for copy the UI shows by key rather than through t() at the string: catalog data
// that must be a value of the English catalog, and bots UI errors whose message is shown as it is.
import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript-api'
import {
  COPY_PRESERVING_BINARY_OPERATORS,
  expressionNameText,
  hasAncestorObjectPropertyName,
  nearestObjectPropertyName
} from './localization-ast-queries.mjs'

// Catalog data the UI shows by id: each string must also be a value of the English catalog, so a
// new entry fails until its key is added.
export const CATALOG_DATA_KEYS = [
  {
    prefix: 'src/shared/bots/bot-template-catalog/',
    keys: new Set(['name', 'line', 'firstChat', 'watches', 'does', 'reports', 'example']),
    // An event's name is keyed by its trigger and action parts, never whole.
    skipUnder: new Set(['events'])
  },
  { prefix: 'src/shared/bots/bot-mcp-apps.ts', keys: new Set(['line']) },
  { prefix: 'src/shared/composio/composio-curated-apps.ts', keys: new Set(['line']) }
]

export const ENGLISH_CATALOG_PATH = path.join(
  'src',
  'renderer',
  'src',
  'i18n',
  'locales',
  'en.json'
)

// Bots code whose thrown messages reach toasts and error lines as they are.
export const ERROR_MESSAGE_PREFIXES = [
  'src/renderer/src/components/bots/',
  'src/renderer/src/components/settings/bots/',
  'mobile/src/bots/'
]

export function catalogDataKind(relativePath, node) {
  const catalog = CATALOG_DATA_KEYS.find((entry) => relativePath.startsWith(entry.prefix))
  const key = catalog && nearestObjectPropertyName(node)
  return key &&
    catalog.keys.has(key) &&
    !(catalog.skipUnder && hasAncestorObjectPropertyName(node, catalog.skipUnder))
    ? `catalog-data:${key}`
    : undefined
}

/** `new SomeError('<prose>')` in bots UI code: its message is shown as it is. */
export function isErrorMessage(relativePath, node) {
  if (!ERROR_MESSAGE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return false
  }
  let current = node
  while (
    ts.isConditionalExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent) ||
    (ts.isBinaryExpression(current.parent) &&
      COPY_PRESERVING_BINARY_OPERATORS.has(current.parent.operatorToken.kind))
  ) {
    if (ts.isConditionalExpression(current.parent) && current.parent.condition === current) {
      return false
    }
    current = current.parent
  }
  const call = current.parent
  return (
    ts.isNewExpression(call) &&
    call.arguments?.[0] === current &&
    (expressionNameText(call.expression) ?? '').endsWith('Error')
  )
}

/** The English catalog's values, which catalog data must match. */
export async function readCatalogEnglish(root) {
  const values = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      values.add(node.replace(/\s+/g, ' ').trim())
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk)
    }
  }
  walk(JSON.parse(await fs.readFile(path.resolve(root, ENGLISH_CATALOG_PATH), 'utf8')))
  return values
}
