import path from 'node:path'
import ts from 'typescript-api'
import {
  literalString,
  propertyName,
  unwrap
} from '../module-requests/static-module-specifiers.mjs'

const FALLBACK_OPERATORS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken])

function normalized(file) {
  return file.replaceAll('\\', '/')
}

function moduleKey(file) {
  return normalized(file).replace(/\.[cm]?[jt]sx?$/, '')
}

export function isValueReference(node) {
  const parent = node.parent
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  ) {
    return false
  }
  if (ts.isExportSpecifier(parent)) {
    return !parent.parent.parent.moduleSpecifier && node === (parent.propertyName ?? parent.name)
  }
  if (ts.isBindingElement(parent)) {
    return node === parent.initializer
  }
  return (
    ts.isShorthandPropertyAssignment(parent) ||
    (parent.name !== node && parent.propertyName !== node && parent.label !== node)
  )
}

function isExportedDeclaration(declaration) {
  const statement = declaration.parent?.parent
  return (
    !!statement &&
    ts.isVariableStatement(statement) &&
    !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
}

/**
 * Each family lists module specifiers (packages, or repo paths without extension) and the gated
 * exports to count, each with advice for the failure message.
 */
export function createGatedCallCollector(families, ratchetName) {
  const advice = new Map(families.flatMap((family) => Object.entries(family.advice)))
  const markers = [
    ...advice.keys(),
    ...families.flatMap((family) => Object.keys(family.localAdvice ?? {})),
    ...families.filter((family) => family.exportPattern).map(() => 'Sync'),
    ...new Set(
      families.flatMap((family) => family.modules.map((module) => path.posix.basename(module)))
    )
  ]
  // Why: helper propagation yields thousands of markers; one alternation scans each file once.
  const markerPattern = markers.length
    ? new RegExp(
        [...new Set(markers)]
          .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')
      )
    : null

  const familiesByModule = new Map()
  for (const family of families) {
    for (const module of family.modules) {
      familiesByModule.set(module, [...(familiesByModule.get(module) ?? []), family])
    }
  }

  function symbolsOf(key, local = false) {
    const matched = familiesByModule.get(key)
    if (!matched) {
      return null
    }
    const names = new Set(
      matched.flatMap((family) => [
        ...Object.keys(family.advice),
        ...(local ? Object.keys(family.localAdvice ?? {}) : [])
      ])
    )
    const patterns = matched.map((family) => family.exportPattern).filter(Boolean)
    names.has = (name) =>
      Set.prototype.has.call(names, name) ||
      (typeof name === 'string' && patterns.some((pattern) => pattern.test(name)))
    names.moduleKey = key
    return names
  }

  function gatedSymbolsFor(file, specifier) {
    const normalizedSpecifier = normalized(specifier)
    if (!normalizedSpecifier.startsWith('.')) {
      return symbolsOf(normalizedSpecifier)
    }
    return symbolsOf(
      moduleKey(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(normalized(file)), normalizedSpecifier)
        )
      )
    )
  }

  // Count each gated value reference, alias use and re-export; imports and plain alias bindings alone do not count.
  // File-wide, not scope-aware: computed specifiers/members and non-const holder flows are unresolved; local wrappers are not traced.
  function collectUses(file, contents) {
    // Escaped spellings and relative imports inside gated modules still need the full analysis.
    const analyze =
      contents.includes('\\') ||
      (markerPattern !== null && (markerPattern.test(contents) || markerPattern.test(file)))
    const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, analyze)
    if (source.parseDiagnostics.length > 0) {
      throw new Error(`Cannot parse ${file}; the ${ratchetName} ratchet must not skip it.`)
    }
    if (!analyze) {
      return { count: 0, symbols: [], sites: [] }
    }
    const used = new Set()
    const sites = []
    let count = 0
    const namespaces = new Map(
      families.flatMap((family) =>
        (family.globals ?? []).map((name) => [name, new Set(Object.keys(family.advice))])
      )
    )
    const functions = new Map(
      [...(symbolsOf(moduleKey(file), true) ?? [])].map((name) => [name, name])
    )
    // Which module each local function binding came from, so same-named exports stay distinct.
    const origins = new Map([...functions.keys()].map((name) => [name, moduleKey(file)]))
    const aliases = []
    const members = []
    const identifiers = []
    const destructures = []

    function moduleSymbols(node) {
      node = unwrap(node)
      if (!node) {
        return null
      }
      if (ts.isIdentifier(node)) {
        return namespaces.get(node.text) ?? null
      }
      const loads =
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          (ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'process' &&
            node.expression.name.text === 'getBuiltinModule'))
      const specifier = loads ? literalString(node.arguments[0]) : null
      return specifier === null ? null : gatedSymbolsFor(file, specifier)
    }
    function gatedFunction(node) {
      node = unwrap(node)
      if (!node) {
        return null
      }
      if (ts.isIdentifier(node)) {
        return functions.get(node.text) ?? null
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = propertyName(node)
        return moduleSymbols(node.expression)?.has(name) ? name : null
      }
      if (ts.isConditionalExpression(node)) {
        return gatedFunction(node.whenTrue) ?? gatedFunction(node.whenFalse)
      }
      if (ts.isBinaryExpression(node) && FALLBACK_OPERATORS.has(node.operatorToken.kind)) {
        return gatedFunction(node.left) ?? gatedFunction(node.right)
      }
      return null
    }
    function recordUse(name, node, module) {
      used.add(name)
      sites.push({ name, position: node.getStart(source), module })
      count += 1
    }
    function visitImport(node) {
      const symbols = gatedSymbolsFor(file, node.moduleSpecifier.text)
      const clause = node.importClause
      if (!symbols || !clause || clause.isTypeOnly) {
        return
      }
      if (clause.name) {
        namespaces.set(clause.name.text, symbols)
        if (symbols.has('default')) {
          functions.set(clause.name.text, 'default')
          origins.set(clause.name.text, symbols.moduleKey)
        }
      }
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) {
        namespaces.set(named.name.text, symbols)
      }
      for (const element of named && ts.isNamedImports(named) ? named.elements : []) {
        const imported = (element.propertyName ?? element.name).text
        if (!element.isTypeOnly && symbols.has(imported)) {
          functions.set(element.name.text, imported)
          origins.set(element.name.text, symbols.moduleKey)
        }
      }
    }
    function visitExport(node) {
      const symbols =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly
          ? gatedSymbolsFor(file, node.moduleSpecifier.text)
          : null
      if (!symbols) {
        return
      }
      const names =
        !node.exportClause || ts.isNamespaceExport(node.exportClause)
          ? [...symbols]
          : node.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => (element.propertyName ?? element.name).text)
      for (const name of names.filter((name) => symbols.has(name))) {
        recordUse(name, node, symbols.moduleKey)
      }
    }
    function visit(node) {
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
        return
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        visitImport(node)
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        const symbols = gatedSymbolsFor(file, node.moduleReference.expression.text)
        if (symbols) {
          namespaces.set(node.name.text, symbols)
        }
      } else if (ts.isExportDeclaration(node)) {
        visitExport(node)
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        members.push(node)
      } else if (ts.isIdentifier(node) && isValueReference(node)) {
        identifiers.push(node)
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          aliases.push({ name: node.name.text, initializer: node.initializer, declaration: node })
        } else if (ts.isObjectBindingPattern(node.name)) {
          destructures.push(node)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)

    // Aliases can chain (`const cp = require('child_process'); const run = cp.execFileSync`).
    for (let changed = true; changed;) {
      changed = false
      for (const { name, initializer } of aliases) {
        const symbols = moduleSymbols(initializer)
        const gated = symbols ? null : gatedFunction(initializer)
        if (symbols && !namespaces.has(name)) {
          namespaces.set(name, symbols)
          changed = true
        } else if (gated && !functions.has(name)) {
          functions.set(name, gated)
          const target = unwrap(initializer)
          origins.set(
            name,
            target && ts.isIdentifier(target)
              ? origins.get(target.text)
              : target &&
                  (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
                ? moduleSymbols(target.expression)?.moduleKey
                : undefined
          )
          changed = true
        }
      }
      for (const node of destructures) {
        const symbols = moduleSymbols(node.initializer)
        for (const element of symbols ? node.name.elements : []) {
          const key = element.propertyName ?? element.name
          const name = ts.isIdentifier(key) ? key.text : literalString(key)
          if (
            symbols.has(name) &&
            ts.isIdentifier(element.name) &&
            !functions.has(element.name.text)
          ) {
            functions.set(element.name.text, name)
            origins.set(element.name.text, symbols.moduleKey)
            changed = true
          }
        }
      }
    }
    // Binding a tracked alias is setup, not a use: its calls are charged instead, so an alias refactor
    // keeps the count. Conditional/fallback aliases and exported bindings stay charged (conservative).
    const aliasSetup = new Set()
    for (const { name, initializer, declaration } of aliases) {
      const target = unwrap(initializer)
      if (
        functions.has(name) &&
        (ts.isIdentifier(target) ||
          ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
        gatedFunction(target) &&
        !isExportedDeclaration(declaration)
      ) {
        aliasSetup.add(target)
      }
    }
    for (const node of members) {
      const name = propertyName(node)
      const symbols = aliasSetup.has(node) ? null : moduleSymbols(node.expression)
      if (symbols?.has(name)) {
        recordUse(name, node, symbols.moduleKey)
      }
    }
    for (const node of identifiers) {
      const name = aliasSetup.has(node) ? null : functions.get(node.text)
      if (name) {
        recordUse(name, node, origins.get(node.text))
      }
    }
    return { count, symbols: [...used].sort(), sites }
  }

  function adviceFor(symbols) {
    const groups = new Map()
    for (const symbol of symbols) {
      groups.set(
        advice.get(symbol) ??
          families.find((family) => family.exportPattern?.test(symbol))?.defaultAdvice,
        [
          ...(groups.get(
            advice.get(symbol) ??
              families.find((family) => family.exportPattern?.test(symbol))?.defaultAdvice
          ) ?? []),
          symbol
        ]
      )
    }
    return [...groups].map(([advice, names]) => `${names.join(', ')}: ${advice}.`).join(' ')
  }

  return { collectUses, gatedSymbolsFor, adviceFor }
}
