import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript-api'
import { collectSourceFiles } from './audit-localization-coverage.mjs'

const TRANSLATORS = new Set(['t', 'translate', 'translateMain', 'translateSearchKeyword'])

export function countLookupKeys(filePath, source) {
  const file = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const keys = new Set()
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null
      const key = node.arguments[0]
      if (
        TRANSLATORS.has(name) &&
        key &&
        ts.isStringLiteralLike(key) &&
        node.arguments
          .slice(1)
          .some(
            (argument) =>
              ts.isObjectLiteralExpression(argument) &&
              argument.properties.some(
                (property) =>
                  (ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property)) &&
                  (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                  property.name.text === 'count'
              )
          )
      ) {
        keys.add(key.text)
      }
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === 'Trans'
    ) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      const key = attributes.find(
        (attribute) => attribute.name.getText(file) === 'i18nKey'
      )?.initializer
      if (
        key &&
        ts.isStringLiteral(key) &&
        attributes.some((attribute) => attribute.name.getText(file) === 'count')
      ) {
        keys.add(key.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return keys
}

export async function collectCountLookupKeys(root) {
  const files = await collectSourceFiles(root, path.join(root, 'src'))
  const keys = new Set()
  for (const file of files) {
    for (const key of countLookupKeys(file, await fs.readFile(file, 'utf8'))) {
      keys.add(key)
    }
  }
  return keys
}
