import ts from 'typescript-api'
import { literalString, propertyName, unwrap } from './static-module-specifiers.mjs'

const INDIRECT_NAME =
  /^(?:readFile\w*|readdir\w*|glob(?:Sync|Stream|Iterate|SyncIterate|StreamSync)?|spawn(?:Sync)?|execFile(?:Sync)?|execSync|runProcess\w*|fork|Worker|createRequire|getBuiltinModule|eval|Function)$/
const INDIRECT_CANDIDATE = new RegExp(
  `\\b${INDIRECT_NAME.source.slice(1, -1)}\\b|\\b(?:import|require)\\s*\\(|\\bURL\\b`
)
const INDIRECT_MODULES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'module',
  'node:module',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'vm',
  'node:vm',
  'glob',
  'fast-glob',
  'globby',
  'tinyglobby'
])

export function hasIndirectUnitInputs(file, contents, imports) {
  if (file.endsWith('.json')) {
    return false
  }
  if (imports.some(({ fileName }) => INDIRECT_MODULES.has(fileName))) {
    return true
  }
  if (!INDIRECT_CANDIDATE.test(contents)) {
    return false
  }
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, false)
  if (source.parseDiagnostics.length > 0) {
    return true
  }
  function visit(node) {
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ((ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportSpecifier(node)) &&
        node.isTypeOnly)
    ) {
      return false
    }
    if (ts.isIdentifier(node) && INDIRECT_NAME.test(node.text)) {
      return true
    }
    if (ts.isElementAccessExpression(node) && INDIRECT_NAME.test(propertyName(node) ?? '')) {
      return true
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require')) &&
        literalString(node.arguments[0]) === null
      ) {
        return true
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL'
    ) {
      const url = literalString(node.arguments?.[0])
      if (url === null || !/^(?:https?|wss?):/.test(url)) {
        return true
      }
    }
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(source)
}
