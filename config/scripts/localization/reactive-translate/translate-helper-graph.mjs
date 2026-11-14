import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { listTrackedFiles } from '../../static-analysis/ratchet-baseline/ratchet-baseline.mjs'
import {
  SCAN_ROOT,
  classifyRenderContext,
  evaluatesDuringRender,
  findI18nImports,
  isFunctionLike,
  isScannedRendererPath,
  isShadowed,
  owningReactFunction,
  parseSource,
  reactFunctionKind
} from './render-path-translate.mjs'

// Module-level helpers that reach translate()/getIntlLocale() directly or through other helpers,
// resolved across renderer files via the import graph, and where component/hook renders call them.

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveSpecifier(fromRel, specifier, known) {
  let base
  if (specifier.startsWith('@/') || specifier.startsWith('@renderer/')) {
    base = path.posix.join(SCAN_ROOT, specifier.slice(specifier.indexOf('/') + 1))
  } else if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier))
  } else {
    return null
  }
  if (known.has(base)) {
    return base
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (known.has(base + extension)) {
      return base + extension
    }
  }
  return null
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
}

/** Callable a top-level `const` holds: a function literal, or a factory wrapping one. */
function helperBodyOf(initializer) {
  let current = initializer
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  if (!current) {
    return null
  }
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    return { node: current, wrapped: false }
  }
  // createLocalizedCatalog(() => ...), memoize((x) => ...): calling the const runs the builder.
  if (ts.isCallExpression(current)) {
    const fn = current.arguments.find(
      (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
    )
    if (fn) {
      return { node: fn, wrapped: true }
    }
  }
  return null
}

function scanModule(rel, sf) {
  const helpers = new Map()
  const exports = new Map()
  const imports = new Map()
  const reexports = []
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      helpers.set(statement.name.text, { node: statement, wrapped: false, typed: false })
      if (hasExportModifier(statement)) {
        const isDefault = statement.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        exports.set(isDefault ? 'default' : statement.name.text, statement.name.text)
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          continue
        }
        const body = helperBodyOf(decl.initializer)
        if (body) {
          helpers.set(decl.name.text, { ...body, typed: Boolean(decl.type) })
        }
        if (hasExportModifier(statement)) {
          exports.set(decl.name.text, decl.name.text)
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          reexports.push({
            name: element.name.text,
            imported: local,
            specifier: statement.moduleSpecifier.text
          })
        } else {
          exports.set(element.name.text, local)
        }
      }
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) {
        continue
      }
      const specifier = statement.moduleSpecifier.text
      if (clause.name) {
        imports.set(clause.name.text, { specifier, imported: 'default' })
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) {
            imports.set(element.name.text, {
              specifier,
              imported: (element.propertyName ?? element.name).text
            })
          }
        }
      }
    }
  }
  return { rel, sf, helpers, exports, imports, reexports }
}

/** Identifier references under `node`, skipping property names and declarations' own names. */
function forEachReference(node, visit) {
  const walk = (child) => {
    if (ts.isIdentifier(child)) {
      const parent = child.parent
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === child) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isJsxAttribute(parent) ||
          ts.isMethodDeclaration(parent)) &&
          parent.name === child) ||
        (ts.isQualifiedName(parent) && parent.right === child) ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isTypeReferenceNode(parent) ||
        ts.isTypeQueryNode(parent) ||
        ((ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent)) &&
          parent.name === child)
      if (!isName) {
        visit(child)
      }
      return
    }
    ts.forEachChild(child, walk)
  }
  walk(node)
}

const TEST_SOURCE = /\.(?:test|spec)\.tsx?$/

/**
 * Parsed renderer sources. With `includeTests`, test files join as `test` modules: they declare no
 * helpers, but their references still count (a test passing a helper as a value pins its arity).
 */
export function loadRendererModules(root = process.cwd(), { includeTests = false } = {}) {
  const files = listTrackedFiles(root, [SCAN_ROOT]).filter(
    (rel) => isScannedRendererPath(rel) || (includeTests && TEST_SOURCE.test(rel))
  )
  const modules = new Map()
  for (const rel of files) {
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    modules.set(rel, {
      ...scanModule(rel, parseSource(rel, text)),
      test: !isScannedRendererPath(rel)
    })
  }
  return modules
}

/** Resolves a name imported into `mod` to the declaring module and its local helper name. */
function resolveImported(modules, mod, localName, depth = 0) {
  const binding = mod.imports.get(localName)
  if (!binding || depth > 8) {
    return null
  }
  const target = resolveSpecifier(mod.rel, binding.specifier, modules)
  return target ? resolveExport(modules, modules.get(target), binding.imported, depth + 1) : null
}

function resolveExport(modules, mod, exportedName, depth) {
  const local = mod.exports.get(exportedName)
  if (local !== undefined) {
    if (mod.helpers.has(local)) {
      return { rel: mod.rel, name: local }
    }
    return resolveImported(modules, mod, local, depth)
  }
  const reexport = mod.reexports.find((entry) => entry.name === exportedName)
  if (reexport && depth <= 8) {
    const target = resolveSpecifier(mod.rel, reexport.specifier, modules)
    return target ? resolveExport(modules, modules.get(target), reexport.imported, depth + 1) : null
  }
  return null
}

function resolveReference(modules, mod, identifier) {
  const name = identifier.text
  if (isShadowed(identifier, name)) {
    return null
  }
  if (mod.helpers.has(name)) {
    return { rel: mod.rel, name }
  }
  return resolveImported(modules, mod, name)
}

export const helperId = (ref) => `${ref.rel}#${ref.name}`

/**
 * Builds the helper graph. A helper "translates" when its body calls translate()/getIntlLocale()
 * or references a helper that does; component and hook functions are owners, not helpers.
 */
export function buildTranslateHelperGraph(modules) {
  const nodes = new Map()
  for (const mod of modules.values()) {
    if (mod.test) {
      continue
    }
    const { locals } = findI18nImports(mod.sf)
    for (const [name, helper] of mod.helpers) {
      if (reactFunctionKind(helper.node)) {
        continue
      }
      const id = helperId({ rel: mod.rel, name })
      const node = {
        id,
        rel: mod.rel,
        name,
        ...helper,
        direct: new Set(),
        callees: new Set(),
        valueUses: 0
      }
      forEachReference(helper.node, (identifier) => {
        if (locals.has(identifier.text) && !isShadowed(identifier, identifier.text)) {
          node.direct.add(locals.get(identifier.text))
          return
        }
        const ref = resolveReference(modules, mod, identifier)
        if (ref && helperId(ref) !== id) {
          node.callees.add(helperId(ref))
        }
      })
      nodes.set(id, node)
    }
  }
  // Reverse-propagate until stable: callers of translating helpers translate too.
  const translating = new Map()
  for (const node of nodes.values()) {
    if (node.direct.size > 0) {
      translating.set(node.id, 0)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes.values()) {
      if (translating.has(node.id)) {
        continue
      }
      const depths = [...node.callees]
        .filter((id) => translating.has(id))
        .map((id) => translating.get(id))
      if (depths.length > 0) {
        translating.set(node.id, Math.min(...depths) + 1)
        changed = true
      }
    }
  }
  return { nodes, translating }
}

/** References to translating helpers from component/hook render paths, plus all other uses. */
export function collectHelperUses(modules, graph) {
  const renderUses = []
  const otherUses = []
  for (const mod of modules.values()) {
    forEachReference(mod.sf, (identifier) => {
      const ref = resolveReference(modules, mod, identifier)
      if (!ref) {
        return
      }
      const id = helperId(ref)
      if (!graph.translating.has(id)) {
        return
      }
      const isCall =
        ts.isCallExpression(identifier.parent) && identifier.parent.expression === identifier
      const owner = owningReactFunction(identifier)
      const { context } = owner ? classifyRenderContext(identifier, owner) : { context: 'module' }
      const duringRender = Boolean(owner) && evaluatesDuringRender(identifier, owner)
      const use = {
        id,
        rel: mod.rel,
        test: mod.test,
        identifier,
        isCall,
        owner,
        context,
        duringRender
      }
      if (owner && context !== 'deferred') {
        renderUses.push(use)
      } else {
        otherUses.push(use)
      }
    })
  }
  return { renderUses, otherUses }
}

export { isFunctionLike }
