import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript-api'

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
}

function literalProperties(source) {
  const exports = new Map()
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    ) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer
      if (
        !ts.isIdentifier(declaration.name) ||
        !value ||
        !ts.isAsExpression(value) ||
        value.type.getText(source) !== 'const' ||
        !ts.isObjectLiteralExpression(value.expression) ||
        value.expression.properties.some(
          (property) =>
            ts.isSpreadAssignment(property) ||
            (property.name && ts.isComputedPropertyName(property.name))
        )
      ) {
        continue
      }
      const properties = new Map()
      for (const property of value.expression.properties) {
        if (
          property.name &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ) {
          properties.delete(property.name.text)
        }
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          properties.set(property.name.text, property.initializer.text)
        }
      }
      exports.set(declaration.name.text, properties)
    }
  }
  return exports
}

export async function collectConstantFallbacks(file, text, cache = new Map()) {
  const source = parse(file, text)
  const needed = new Set()
  const declared = new Set()
  function collect(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments[1] &&
      ts.isPropertyAccessExpression(node.arguments[1]) &&
      ts.isIdentifier(node.arguments[1].expression)
    ) {
      needed.add(node.arguments[1].expression.text)
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  const fallbacks = new Map()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('.')
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue
    }
    const names = bindings.elements.filter(
      (name) => needed.has(name.name.text) && !declared.has(name.name.text)
    )
    if (!names.length) {
      continue
    }
    const target = path.resolve(path.dirname(file), statement.moduleSpecifier.text)
    if (!cache.has(target)) {
      const read = async () => {
        for (const candidate of [target, `${target}.ts`, `${target}.tsx`]) {
          try {
            return literalProperties(parse(candidate, await fs.readFile(candidate, 'utf8')))
          } catch (error) {
            if (!['ENOENT', 'EISDIR'].includes(error.code)) {
              throw error
            }
          }
        }
        return new Map()
      }
      cache.set(target, read())
    }
    const exported = await cache.get(target)
    for (const name of names) {
      for (const [property, value] of exported.get(name.propertyName?.text ?? name.name.text) ??
        []) {
        fallbacks.set(`${name.name.text}.${property}`, value)
      }
    }
  }
  return fallbacks
}
