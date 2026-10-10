import ts from 'typescript-api'

const MODULE_BUILTINS = new Set(['module', 'node:module'])
const PROCESS_BUILTINS = new Set(['process', 'node:process'])

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isAwaitExpression(node))
  ) {
    node = node.expression
  }
  return node
}

function isNamed(node, name) {
  return ts.isIdentifier(node) && node.text === name
}

function literalString(node) {
  node = unwrap(node)
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text
  }
  return ts.isElementAccessExpression(node) ? literalString(node.argumentExpression) : null
}

function isConstDeclaration(node) {
  return ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
}

function collectBindings(source) {
  const strings = new Map()
  const declarations = []
  const destructures = []
  const imports = []
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer)
      if (ts.isIdentifier(node.name)) {
        declarations.push({ name: node.name.text, initializer })
        const value = literalString(initializer)
        if (isConstDeclaration(node) && value !== null) {
          strings.set(node.name.text, [...(strings.get(node.name.text) ?? []), value])
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name
          const name = ts.isIdentifier(key) ? key.text : literalString(key)
          if (ts.isIdentifier(element.name) && name !== null) {
            destructures.push({ name: element.name.text, key: name, initializer })
          }
        }
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ module: node.moduleSpecifier.text, clause: node.importClause })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({ module: node.moduleReference.expression.text, namespace: node.name })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { strings, declarations, destructures, imports }
}

/**
 * Specifiers a file statically loads: imports, re-exports, `import()`, `require`/`require.resolve`,
 * `module.require`, `createRequire(...)` loaders and their aliases, and `process.getBuiltinModule`.
 * A specifier argument may be a literal or a file-level `const` string. Name bindings are
 * file-wide, not scope-aware. Literal property keys are resolved; computed key values are not.
 * Computed specifiers (concatenation, templates with substitutions, parameters, values imported
 * from other files), loaders stored in objects or passed as arguments, and `eval`/`Function`
 * are not resolved.
 */
export function collectModuleSpecifiers(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse ${file}; the process-host import check must not skip it.`)
  }
  const { strings, declarations, destructures, imports } = collectBindings(source)
  const loaders = new Set(['require'])
  const createRequires = new Set()
  const moduleNamespaces = new Set()
  const processes = new Set(['process'])
  const builtinLoaders = new Set()

  function specifierValues(node) {
    node = unwrap(node)
    const value = literalString(node)
    if (value !== null) {
      return [value]
    }
    return node && ts.isIdentifier(node) ? (strings.get(node.text) ?? []) : []
  }
  function isProcess(node) {
    node = unwrap(node)
    return (
      (ts.isIdentifier(node) && processes.has(node.text)) ||
      (propertyName(node) === 'process' && isNamed(node.expression, 'globalThis')) ||
      loadsAny(node, PROCESS_BUILTINS)
    )
  }
  function isBuiltinLoader(node) {
    node = unwrap(node)
    return (
      (ts.isIdentifier(node) && builtinLoaders.has(node.text)) ||
      (propertyName(node) === 'getBuiltinModule' && isProcess(node.expression))
    )
  }
  function isCreateRequire(node) {
    node = unwrap(node)
    return (
      (ts.isIdentifier(node) && createRequires.has(node.text)) ||
      (propertyName(node) === 'createRequire' && isModuleNamespace(node.expression))
    )
  }
  function isLoader(node) {
    node = unwrap(node)
    return (
      (ts.isIdentifier(node) && loaders.has(node.text)) ||
      (propertyName(node) === 'require' && isNamed(node.expression, 'module')) ||
      (ts.isCallExpression(node) && isCreateRequire(node.expression))
    )
  }
  function loadsAny(node, specifiers) {
    return (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isLoader(node.expression) ||
        isBuiltinLoader(node.expression)) &&
      specifierValues(node.arguments[0]).some((specifier) => specifiers.has(specifier))
    )
  }
  function isModuleNamespace(node) {
    node = unwrap(node)
    return (
      (ts.isIdentifier(node) && moduleNamespaces.has(node.text)) || loadsAny(node, MODULE_BUILTINS)
    )
  }

  for (const { module, clause, namespace } of imports) {
    const named = clause?.namedBindings
    const local = [
      namespace,
      clause?.name,
      named && ts.isNamespaceImport(named) ? named.name : null
    ]
    for (const name of local.filter(Boolean)) {
      if (MODULE_BUILTINS.has(module)) {
        moduleNamespaces.add(name.text)
      }
      if (PROCESS_BUILTINS.has(module)) {
        processes.add(name.text)
      }
    }
    for (const element of named && ts.isNamedImports(named) ? named.elements : []) {
      const imported = (element.propertyName ?? element.name).text
      if (MODULE_BUILTINS.has(module) && (imported === 'default' || imported === 'Module')) {
        moduleNamespaces.add(element.name.text)
      }
      if (PROCESS_BUILTINS.has(module) && imported === 'default') {
        processes.add(element.name.text)
      }
      if (MODULE_BUILTINS.has(module) && imported === 'createRequire') {
        createRequires.add(element.name.text)
      }
      if (PROCESS_BUILTINS.has(module) && imported === 'getBuiltinModule') {
        builtinLoaders.add(element.name.text)
      }
    }
  }
  // Aliases can chain (`const m = require('module'); const r = m.createRequire(x)`).
  for (let changed = true; changed;) {
    changed = false
    const bind = (set, name, matches) => {
      if (matches && !set.has(name)) {
        set.add(name)
        changed = true
      }
    }
    for (const { name, initializer } of declarations) {
      bind(loaders, name, isLoader(initializer))
      bind(createRequires, name, isCreateRequire(initializer))
      bind(moduleNamespaces, name, isModuleNamespace(initializer))
      bind(processes, name, isProcess(initializer))
      bind(builtinLoaders, name, isBuiltinLoader(initializer))
    }
    for (const { name, key, initializer } of destructures) {
      bind(createRequires, name, key === 'createRequire' && isModuleNamespace(initializer))
      bind(builtinLoaders, name, key === 'getBuiltinModule' && isProcess(initializer))
    }
  }

  const specifiers = new Set()
  function add(node) {
    for (const specifier of specifierValues(node)) {
      specifiers.add(specifier)
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal)
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        isLoader(callee) ||
        isBuiltinLoader(callee) ||
        (propertyName(callee) === 'resolve' && isLoader(callee.expression))
      ) {
        add(node.arguments[0])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...specifiers]
}
