// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

function bindingDeclarations(name, declaration, entries = []) {
  if (!name) {
    return entries
  }
  if (ts.isIdentifier(name)) {
    entries.push([name.text, declaration])
  } else {
    for (const element of name.elements) {
      bindingDeclarations(element.name, element, entries)
    }
  }
  return entries
}

function isLexicalScope(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionLike(node) ||
    ts.isModuleBlock(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  )
}

function nearestScope(node, sourceFile, predicate = isLexicalScope) {
  let current = node.parent
  while (current && current !== sourceFile) {
    if (predicate(current)) {
      return current
    }
    current = current.parent
  }
  return sourceFile
}

function varScope(node, sourceFile) {
  return nearestScope(
    node,
    sourceFile,
    (scope) =>
      ts.isFunctionLike(scope) || ts.isModuleBlock(scope) || ts.isClassStaticBlockDeclaration(scope)
  )
}

function collectDeclarations(sourceFile) {
  const declarations = new Map()

  function add(scope, name, declaration) {
    const byName = declarations.get(scope) ?? new Map()
    const matches = byName.get(name) ?? []
    matches.push(declaration)
    byName.set(name, matches)
    declarations.set(scope, byName)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.name) {
        add(sourceFile, clause.name.text, clause.name)
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        add(sourceFile, clause.namedBindings.name.text, clause.namedBindings)
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          add(sourceFile, element.name.text, element)
        }
      }
    } else if (ts.isParameter(node)) {
      for (const [name, declaration] of bindingDeclarations(node.name, node)) {
        add(node.parent, name, declaration)
      }
    } else if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent
      const scope =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
          ? varScope(node, sourceFile)
          : nearestScope(node, sourceFile)
      for (const [name, declaration] of bindingDeclarations(node.name, node)) {
        add(scope, name, declaration)
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      add(nearestScope(node, sourceFile), node.name.text, node)
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      add(node, node.name.text, node)
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const [name, declaration] of bindingDeclarations(
        node.variableDeclaration.name,
        node.variableDeclaration
      )) {
        add(node, name, declaration)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return declarations
}

export function collectSourceBindings(sourceFile) {
  const declarations = collectDeclarations(sourceFile)
  return {
    resolveBinding(identifier) {
      let current = identifier.parent
      while (current) {
        const matches = declarations.get(current)?.get(identifier.text)
        if (matches?.length) {
          return matches[0]
        }
        if (current === sourceFile) {
          break
        }
        current = current.parent
      }
      return undefined
    }
  }
}
