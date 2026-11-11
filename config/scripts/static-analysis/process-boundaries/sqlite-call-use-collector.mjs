import ts from 'typescript-api'
import { propertyName, unwrap } from '../module-requests/static-module-specifiers.mjs'

const METHODS = new Set(['prepare', 'run', 'get', 'all', 'exec'])
const SQLITE_MODULE =
  /^(?:node:sqlite|better-sqlite3)$|(?:^|\/)(?:sync-database|sqlite-statement)(?:\.[cm]?[jt]s)?$/

// Local syntax only: imported SQLite types, typed receivers, constructors and prepare() results.
export function countSqliteCalls(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length) {
    throw new Error(`Cannot parse ${file}; SQLite ratchet must not skip it.`)
  }
  const types = new Set()
  const constructors = new Set()
  const receivers = new Set()
  const declarations = []
  const calls = []
  const key = (node) => unwrap(node)?.getText(source)
  function constructor(node) {
    const text = key(node)
    return (
      constructors.has(text) ||
      ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        types.has(key(node.expression)) &&
        propertyName(node) === 'DatabaseSync')
    )
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && SQLITE_MODULE.test(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause?.name) {
        types.add(clause.name.text)
        if (!clause.isTypeOnly) {
          constructors.add(clause.name.text)
        }
      }
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) {
        types.add(named.name.text)
      }
      for (const element of named && ts.isNamedImports(named) ? named.elements : []) {
        if (
          ['DatabaseSync', 'StatementSync', 'SqliteStatement'].includes(
            (element.propertyName ?? element.name).text
          )
        ) {
          types.add(element.name.text)
          if (!clause.isTypeOnly && !element.isTypeOnly) {
            constructors.add(element.name.text)
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      key(node.initializer.expression) === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]) &&
      SQLITE_MODULE.test(node.initializer.arguments[0].text)
    ) {
      if (ts.isIdentifier(node.name)) {
        types.add(node.name.text)
        constructors.add(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (
            (element.propertyName ?? element.name).getText(source) === 'DatabaseSync' &&
            ts.isIdentifier(element.name)
          ) {
            types.add(element.name.text)
            constructors.add(element.name.text)
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) {
      declarations.push(node)
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const sqliteType = (node) => {
    if (!node) {
      return false
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.some(sqliteType)
    }
    if (!ts.isTypeReferenceNode(node)) {
      return false
    }
    const name = node.typeName.getText(source)
    return (
      types.has(name.split('.')[0]) && (!name.includes('.') || /\.(Database|Statement)$/.test(name))
    )
  }
  function instance(node) {
    node = unwrap(node)
    if (!node) {
      return false
    }
    if (receivers.has(key(node))) {
      return true
    }
    if (ts.isNewExpression(node)) {
      return constructor(node.expression)
    }
    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression))
    ) {
      return propertyName(node.expression) === 'prepare' && instance(node.expression.expression)
    }
    return false
  }
  for (let changed = true; changed;) {
    changed = false
    for (const node of declarations) {
      if (!ts.isIdentifier(node.name) || !(sqliteType(node.type) || instance(node.initializer))) {
        continue
      }
      const name = ts.isPropertyDeclaration(node) ? `this.${node.name.text}` : node.name.text
      if (!receivers.has(name)) {
        receivers.add(name)
        changed = true
      }
    }
  }
  return calls.filter((node) => {
    const target = unwrap(node.expression)
    if (ts.isNewExpression(node)) {
      return constructor(target)
    }
    return (
      (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
      METHODS.has(propertyName(target)) &&
      instance(target.expression)
    )
  }).length
}
