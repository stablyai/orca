import path from 'node:path'
import ts from 'typescript-api'
import { createGatedCallCollector } from './gated-call-use-collector.mjs'
import { unwrap } from '../module-requests/static-module-specifiers.mjs'

// Per-file call counts never see a new caller of an existing sync helper in another file; this
// marks top-level functions that reach a blocking call (directly or through other marked functions)
// and counts every reference to them, so the helper's callers are guarded too.

function moduleKeys(file) {
  const key = file.replace(/\.[cm]?[jt]sx?$/, '')
  return path.posix.basename(key) === 'index' ? [key, path.posix.dirname(key)] : [key]
}

function isExported(node) {
  return !!ts
    .getModifiers?.(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function isFunctionLike(node) {
  node = unwrap(node)
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

/** Top-level functions with their ranges, referenced identifiers, export names and re-exports. */
function scanDeclarations(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  const functions = []
  const exportNames = new Map()
  const reexports = []
  const addFunction = (name, node, exported) => {
    const references = new Set()
    const visit = (child) => {
      if (ts.isIdentifier(child)) {
        references.add(child.text)
      }
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
    functions.push({ name, start: node.getStart(source), end: node.getEnd(), references })
    if (exported) {
      exportNames.set(name, [...(exportNames.get(name) ?? []), name])
    }
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      addFunction(statement.name.text, statement, isExported(statement))
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionLike(declaration.initializer)) {
          addFunction(declaration.name.text, declaration, isExported(statement))
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      !statement.moduleSpecifier
    ) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text
        exportNames.set(local, [...(exportNames.get(local) ?? []), element.name.text])
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('.')
    ) {
      const target = path.posix
        .normalize(path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text))
        .replace(/\.[cm]?[jt]sx?$/, '')
      const names =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => [(element.propertyName ?? element.name).text, element.name.text])
          : null
      reexports.push({ target, names })
    }
  }
  return { functions, exportNames, reexports }
}

/**
 * `direct`: file -> start offsets of blocking calls, with the API each one is. Returns file -> helper
 * references counted, the helper names used, and where each helper's blocking call is.
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
  let uses = new Map()
  for (let round = 0; ; round++) {
    const families = []
    const reachesByModule = new Map()
    for (const [file, marked] of helpers) {
      const { exportNames } = scan(file)
      const names = new Map()
      for (const [local, reaches] of marked) {
        names.set(local, reaches)
        for (const exported of exportNames.get(local) ?? []) {
          names.set(exported, reaches)
        }
      }
      for (const key of moduleKeys(file)) {
        reachesByModule.set(key, names)
      }
    }
    // Barrels re-export helpers under their own module key.
    for (const file of sources.keys()) {
      for (const { target, names } of scan(file).reexports) {
        const reached = reachesByModule.get(target)
        if (!reached) {
          continue
        }
        const own = reachesByModule.get(moduleKeys(file)[0]) ?? new Map()
        for (const [from, to] of names ?? [...reached.keys()].map((name) => [name, name])) {
          if (reached.has(from)) {
            own.set(to, reached.get(from))
          }
        }
        for (const key of moduleKeys(file)) {
          reachesByModule.set(key, own)
        }
      }
    }
    const reachesByName = new Map()
    for (const [key, names] of reachesByModule) {
      families.push({ modules: [key], advice: Object.fromEntries(names) })
      for (const [name, reaches] of names) {
        reachesByName.set(name, reaches)
      }
    }
    const collector = createGatedCallCollector(families, 'main blocking helper')
    const next = new Map()
    let grew = false
    for (const [file, contents] of sources) {
      const { count, symbols, sites } = collector.collectUses(file, contents)
      if (count === 0) {
        continue
      }
      next.set(file, {
        count,
        reaches: symbols.map((name) => `${name} (${reachesByName.get(name)})`)
      })
      const reached = sites.map(({ name, position }) => ({
        position,
        reaches: reachesByName.get(name) ?? name
      }))
      grew = markSites(file, reached) || grew
    }
    uses = next
    if (!grew || round + 1 >= depth) {
      return { uses, helpers }
    }
  }
}
