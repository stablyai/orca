import path from 'node:path'
import ts from 'typescript-api'
import { createGatedCallCollector, isValueReference } from './gated-call-use-collector.mjs'
import { unwrap } from '../module-requests/static-module-specifiers.mjs'

// Per-file call counts never see a new caller of an existing sync helper in another file; this
// marks top-level functions that reach a blocking call (directly or through other marked functions)
// and counts every reference to them, so the helper's callers are guarded too.

function moduleKeys(file) {
  const key = file.replace(/\.[cm]?[jt]sx?$/, '')
  return path.posix.basename(key) === 'index' ? [key, path.posix.dirname(key)] : [key]
}

function hasModifier(node, kind) {
  return !!ts.getModifiers?.(node)?.some((modifier) => modifier.kind === kind)
}

function isFunctionLike(node) {
  node = unwrap(node)
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

/** Runtime references inside a function body: type positions and property names are not calls. Names match
 *  file-wide, like the direct collectors: a local or parameter reusing a helper's name is counted (never missed). */
function scanBody(node) {
  const references = new Set()
  const visit = (child) => {
    if (ts.isTypeNode(child) && !ts.isExpressionWithTypeArguments(child)) {
      return
    }
    if (ts.isIdentifier(child) && isValueReference(child)) {
      references.add(child.text)
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return { references }
}

/** Top-level functions with their ranges, runtime references, export names and re-exports. */
function scanDeclarations(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  const functions = []
  const exportNames = new Map()
  const reexports = []
  const imports = new Map()
  const explicitExports = new Set()
  const exportAs = (local, exported) =>
    exportNames.set(local, [...(exportNames.get(local) ?? []), exported])
  const targetModule = (specifier) =>
    path.posix
      .normalize(path.posix.join(path.posix.dirname(file), specifier))
      .replace(/\.[cm]?[jt]sx?$/, '')
  const reserveBinding = (name) => {
    if (ts.isIdentifier(name)) {
      explicitExports.add(name.text)
    } else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          reserveBinding(element.name)
        }
      }
    }
  }
  const addFunction = (name, node) => {
    functions.push({ name, start: node.getStart(source), end: node.getEnd(), ...scanBody(node) })
  }
  for (const statement of source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    if (
      exported &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      explicitExports.add(isDefault ? 'default' : statement.name.text)
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('.') &&
      statement.importClause &&
      !statement.importClause.isTypeOnly
    ) {
      const target = targetModule(statement.moduleSpecifier.text)
      const clause = statement.importClause
      if (clause.name) {
        imports.set(clause.name.text, { target, name: 'default' })
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) {
            imports.set(element.name.text, {
              target,
              name: (element.propertyName ?? element.name).text
            })
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text ?? 'default'
      addFunction(name, statement)
      if (exported) {
        exportAs(name, isDefault ? 'default' : name)
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (exported) {
          reserveBinding(declaration.name)
        }
        if (ts.isIdentifier(declaration.name) && isFunctionLike(declaration.initializer)) {
          addFunction(declaration.name.text, declaration)
          if (exported) {
            exportAs(declaration.name.text, declaration.name.text)
          }
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const target = unwrap(statement.expression)
      if (target && ts.isIdentifier(target)) {
        exportAs(target.text, 'default')
      } else if (isFunctionLike(target)) {
        addFunction('default', statement)
        exportAs('default', 'default')
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      !statement.moduleSpecifier
    ) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          exportAs((element.propertyName ?? element.name).text, element.name.text)
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('.')
    ) {
      const target = targetModule(statement.moduleSpecifier.text)
      const names =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => [(element.propertyName ?? element.name).text, element.name.text])
          : null
      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        explicitExports.add(statement.exportClause.name.text)
      } else {
        reexports.push({ target, names })
        for (const [, name] of names ?? []) {
          explicitExports.add(name)
        }
      }
    }
  }
  for (const [local, exported] of exportNames) {
    for (const name of exported) {
      explicitExports.add(name)
    }
    const imported = imports.get(local)
    if (imported) {
      reexports.push({
        target: imported.target,
        names: exported.map((name) => [imported.name, name])
      })
    }
  }
  return { functions, exportNames, reexports, explicitExports }
}

/**
 * `direct`: file -> start offsets of blocking calls, with the call each one reaches. Returns file -> helper
 * references counted and the helpers used (each with the blocking call it reaches).
 */
export function collectBlockingHelperUses(sources, direct, { depth = Infinity } = {}) {
  const scans = new Map()
  const scan = (file) => {
    if (!scans.has(file)) {
      scans.set(file, scanDeclarations(file, sources.get(file)))
    }
    return scans.get(file)
  }
  // file -> helper name -> description of the blocking call it reaches.
  const helpers = new Map()
  const markSites = (file, sites) => {
    const { functions } = scan(file)
    const marked = helpers.get(file) ?? new Map()
    let added = false
    for (const { position, reaches } of sites) {
      const owner = functions.find((fn) => position >= fn.start && position < fn.end)
      if (owner && !marked.has(owner.name)) {
        marked.set(owner.name, reaches)
        added = true
      }
    }
    // A function calling a marked function in its own file reaches the same blocking call.
    for (let changed = true; changed;) {
      changed = false
      for (const fn of functions) {
        if (marked.has(fn.name)) {
          continue
        }
        const via = [...fn.references].find((name) => marked.has(name))
        if (via) {
          marked.set(fn.name, marked.get(via))
          changed = added = true
        }
      }
    }
    if (marked.size > 0) {
      helpers.set(file, marked)
    }
    return added
  }
  for (const [file, sites] of direct) {
    if (sources.has(file)) {
      markSites(file, sites)
    }
  }
  const barrels = [...sources.keys()].filter((file) => scan(file).reexports.length > 0)
  for (let round = 0; ; round++) {
    // module key -> exported name -> what it reaches
    const reachesByModule = new Map()
    for (const [file, marked] of helpers) {
      const { exportNames } = scan(file)
      const names = new Map()
      for (const [local, reaches] of marked) {
        for (const exported of exportNames.get(local) ?? []) {
          names.set(exported, reaches)
        }
      }
      for (const key of moduleKeys(file)) {
        reachesByModule.set(key, names)
      }
    }
    // Re-exports add no call depth, so barrels (and barrels of barrels) resolve fully every round.
    for (let changed = true; changed;) {
      changed = false
      for (const file of barrels) {
        const own = reachesByModule.get(moduleKeys(file)[0]) ?? new Map()
        const { reexports, explicitExports } = scan(file)
        for (const { target, names } of reexports) {
          const reached = reachesByModule.get(target)
          const pairs = names ?? [...(reached?.keys() ?? [])].map((name) => [name, name])
          for (const [from, to] of pairs) {
            if (!names && (from === 'default' || explicitExports.has(to))) {
              continue
            }
            if (reached?.has(from) && !own.has(to)) {
              own.set(to, reached.get(from))
              changed = true
            }
          }
        }
        if (own.size > 0) {
          for (const key of moduleKeys(file)) {
            reachesByModule.set(key, own)
          }
        }
      }
    }
    const families = [...reachesByModule].map(([key, names]) => ({
      modules: [key],
      advice: Object.fromEntries(names)
    }))
    for (const [file, marked] of helpers) {
      families.push({
        modules: [moduleKeys(file)[0]],
        advice: {},
        localAdvice: Object.fromEntries(marked)
      })
    }
    const collector = createGatedCallCollector(families, 'main blocking helper')
    const uses = new Map()
    let grew = false
    for (const [file, contents] of sources) {
      const { count, sites } = collector.collectUses(file, contents)
      if (count === 0) {
        continue
      }
      const reached = sites.map(({ name, position, module }) => ({
        position,
        name,
        reaches: reachesByModule.get(module)?.get(name) ?? helpers.get(file)?.get(name) ?? name
      }))
      uses.set(file, {
        count,
        reaches: [...new Set(reached.map(({ name, reaches }) => `${name} (${reaches})`))].sort()
      })
      grew = markSites(file, reached) || grew
    }
    if (!grew || round + 1 >= depth) {
      return { uses, helpers }
    }
  }
}
