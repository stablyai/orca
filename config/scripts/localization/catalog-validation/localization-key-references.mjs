import path from 'node:path'
import process from 'node:process'
import ts from 'typescript-api'
import { pluralFamilyDefaults } from '../../locale-catalog/locale-plural-forms.mjs'

const LOCALIZATION_FUNCTION_NAMES = new Set([
  't',
  'translate',
  'translateMain',
  'translateSearchKeyword'
])

function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
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

function reportAt(root, filePath, sourceFile, node, key, fallback) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    filePath: normalizePath(root, filePath),
    line: position.line + 1,
    column: position.character + 1,
    key,
    fallback
  }
}

export function collectLocalizationKeyReferences(
  filePath,
  sourceText,
  root = process.cwd(),
  constantFallbacks = new Map()
) {
  const sourceKind =
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const references = []

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = expressionNameText(node.expression)
      const functionName = name?.split('.').at(-1)
      const firstArg = node.arguments[0]
      if (
        functionName &&
        LOCALIZATION_FUNCTION_NAMES.has(functionName) &&
        firstArg &&
        ts.isStringLiteralLike(firstArg)
      ) {
        const secondArg = node.arguments[1]
        const fallback =
          secondArg && ts.isStringLiteralLike(secondArg)
            ? secondArg.text
            : secondArg &&
                ts.isPropertyAccessExpression(secondArg) &&
                ts.isIdentifier(secondArg.expression)
              ? constantFallbacks.get(`${secondArg.expression.text}.${secondArg.name.text}`)
              : undefined
        const keys = pluralFamilyDefaults(ts, firstArg.text, fallback, node.arguments[2]) ?? [
          [firstArg.text, fallback]
        ]
        for (const [key, value] of keys) {
          references.push(reportAt(root, filePath, sourceFile, firstArg, key, value))
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}
