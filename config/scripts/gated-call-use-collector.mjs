import path from 'node:path'
import ts from 'typescript-api'
import { literalString, propertyName, unwrap } from './static-module-specifiers.mjs'

const FALLBACK_OPERATORS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken])

function normalized(file) {
  return file.replaceAll('\\', '/')
}

function moduleKey(file) {
  return normalized(file).replace(/\.[cm]?[jt]sx?$/, '')
}

function isValueReference(node) {
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

/**
 * Each family lists module specifiers (packages, or repo paths without extension) and the gated
 * exports to count, each with advice for the failure message.
 */
export function createGatedCallCollector(families, ratchetName) {
  const advice = new Map(families.flatMap((family) => Object.entries(family.advice)))
  const markers = [
    ...advice.keys(),
    ...new Set(
      families.flatMap((family) => family.modules.map((module) => path.posix.basename(module)))
    )
  ]

  function symbolsOf(key) {
    const names = families
      .filter((family) => family.modules.includes(key))
      .flatMap((family) => Object.keys(family.advice))
    return names.length > 0 ? new Set(names) : null
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

  // Count each gated value reference, alias use and re-export; imports alone do not count.
  // File-wide, not scope-aware: computed specifiers/members and non-const holder flows are unresolved; local wrappers are not traced.
  function collectUses(file, contents) {
    // Escaped spellings and relative imports inside gated modules still need the full analysis.
    const analyze =
      contents.includes('\\') ||
      markers.some((marker) => contents.includes(marker) || file.includes(marker))
    const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, analyze)
    if (source.parseDiagnostics.length > 0) {
      throw new Error(`Cannot parse ${file}; the ${ratchetName} ratchet must not skip it.`)
    }
    if (!analyze) {
      return { count: 0, symbols: [] }
    }
    const used = new Set()
    let count = 0
    const namespaces = new Map()
    const functions = new Map([...(symbolsOf(moduleKey(file)) ?? [])].map((name) => [name, name]))
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
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
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
    function recordUse(name) {
      used.add(name)
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
      }
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) {
        namespaces.set(named.name.text, symbols)
      }
      for (const element of named && ts.isNamedImports(named) ? named.elements : []) {
        const imported = (element.propertyName ?? element.name).text
        if (!element.isTypeOnly && symbols.has(imported)) {
          functions.set(element.name.text, imported)
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
        used.add(name)
        count += 1
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
          aliases.push({ name: node.name.text, initializer: node.initializer })
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
            changed = true
          }
        }
      }
    }
    for (const node of members) {
      const name = propertyName(node)
      if (moduleSymbols(node.expression)?.has(name)) {
        recordUse(name)
      }
    }
    for (const node of identifiers) {
      const name = functions.get(node.text)
      if (name) {
        recordUse(name)
      }
    }
    return { count, symbols: [...used].sort() }
  }

  function adviceFor(symbols) {
    const groups = new Map()
    for (const symbol of symbols) {
      groups.set(advice.get(symbol), [...(groups.get(advice.get(symbol)) ?? []), symbol])
    }
    return [...groups].map(([advice, names]) => `${names.join(', ')}: ${advice}.`).join(' ')
  }

  return { collectUses, gatedSymbolsFor, adviceFor }
}
