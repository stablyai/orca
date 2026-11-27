import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import {
  evaluatesDuringRender,
  isShadowed,
  owningReactFunction,
  parseSource
} from '../../../localization/reactive-translate/render-path-translate.mjs'
import { findSourceHazards } from './react-compiler-hazards.mjs'

// The mobile app is built with React Compiler, which memoizes a render on props, state and hook
// results only. Theme and language live in module state, so a render that reads them directly
// (or through a helper that does) keeps the old scheme or language after a switch.

const SCAN_ROOTS = ['mobile/app', 'mobile/src', 'mobile/web-entry']
const BASELINE_PATH = 'config/mobile-react-compiler-hazard-baseline.txt'
const COMMAND = 'pnpm check:mobile-react-compiler-hazard-ratchet'
const HEADER = [
  '# Mobile render-path reads of module theme/language state and React Compiler hazards, per file.',
  '# This is a RATCHET: counts may only go DOWN. Read useMobileColors(), useThemedStyles(),',
  `# useMobileTranslation(), useMobileUiLocale() during render. Prune after a fix: ${COMMAND} --prune`
]
const LIVE_MODULES = new Map([
  ['mobile/src/i18n/mobile-i18n', ['translate', 'getMobileUiLocale']],
  ['mobile/src/theme/mobile-theme', ['getMobileColorScheme', 'getMobilePalette']]
])
// The hooks' own modules read module state by design.
const HOOK_SOURCES = new Set([
  'mobile/src/i18n/use-mobile-translation.ts',
  'mobile/src/theme/use-mobile-color-scheme.ts',
  'mobile/src/theme/themed-styles.ts'
])

export function isScannedMobilePath(rel) {
  return (
    !HOOK_SOURCES.has(rel) &&
    SCAN_ROOTS.some((root) => rel.startsWith(`${root}/`)) &&
    /\.tsx?$/.test(rel) &&
    !rel.endsWith('.d.ts') &&
    !rel.includes('.generated.') &&
    !/\.(?:test|spec|fixture|test-fixture)\.tsx?$/.test(rel) &&
    !rel.includes('/__tests__/')
  )
}

function moduleId(fromRel, specifier) {
  if (!specifier.startsWith('.')) {
    return null
  }
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(fromRel), specifier))
    .replace(/\.(?:web|ios|android|native)$/, '')
    .replace(/\/index$/, '')
}

function stripExtension(rel) {
  return rel.replace(/(?:\.(?:web|ios|android|native))?\.tsx?$/, '').replace(/\/index$/, '')
}

/** Local names bound to live readers: the readers themselves and wrappers exported elsewhere. */
function liveImports(sf, rel, wrappersByModule) {
  const locals = new Set()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause.isTypeOnly) {
      continue
    }
    const id = moduleId(rel, statement.moduleSpecifier.text)
    const live = new Set([...(LIVE_MODULES.get(id) ?? []), ...(wrappersByModule.get(id) ?? [])])
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && live.has((element.propertyName ?? element.name).text)) {
        locals.add(element.name.text)
      }
    }
  }
  return locals
}

function moduleFunctions(sf) {
  const functions = new Map()
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer
        if (
          ts.isIdentifier(declaration.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          functions.set(declaration.name.text, init)
        }
      }
    }
  }
  return functions
}

function liveCalls(node, names) {
  const calls = []
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      names.has(child.expression.text) &&
      !isShadowed(child.expression, child.expression.text)
    ) {
      calls.push(child)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return calls
}

// A plain module function that calls a live reader synchronously returns live state too.
function readsSynchronously(call, fn) {
  for (let current = call.parent; current && current !== fn; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      const parent = current.parent
      if (!(ts.isCallExpression(parent) && parent.arguments.includes(current))) {
        return false
      }
    }
  }
  return true
}

function localWrappers(sf, live) {
  const functions = moduleFunctions(sf)
  const names = new Set(live)
  for (let grew = true; grew;) {
    grew = false
    for (const [name, fn] of functions) {
      if (names.has(name) || /^(?:use[A-Z0-9]|[A-Z])/.test(name)) {
        continue
      }
      if (liveCalls(fn, names).some((call) => readsSynchronously(call, fn))) {
        names.add(name)
        grew = true
      }
    }
  }
  return names
}

function isExported(sf, name) {
  return sf.statements.some(
    (statement) =>
      ((ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (d) => ts.isIdentifier(d.name) && d.name.text === name
          ))) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

// A getter hides the read behind a property, so a render that reads the property reads live state
// that the compiler cannot see; pass `t` to a function instead.
function liveGetters(calls) {
  const getters = new Set()
  for (const call of calls) {
    for (let current = call.parent; current; current = current.parent) {
      if (ts.isGetAccessorDeclaration(current) && ts.isObjectLiteralExpression(current.parent)) {
        getters.add(current)
        break
      }
      if (ts.isFunctionDeclaration(current) || ts.isClassLike(current)) {
        break
      }
    }
  }
  return getters
}

function rootName(expression) {
  let current = expression
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isCallExpression(current)
  ) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : null
}

// Compiled, useMemo/useCallback key on what the callback reads, so a listed dep it never reads no
// longer invalidates it; wrap the work in recomputeOn([dep], () => ...) from hooks/recompute-on.
function unreadMemoDeps(sf) {
  let count = 0
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      /^(?:React\.)?use(?:Memo|Callback)$/.test(node.expression.getText(sf)) &&
      node.arguments.length === 2 &&
      ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      const read = new Set()
      const collect = (child) => {
        if (ts.isIdentifier(child)) {
          read.add(child.text)
        }
        ts.forEachChild(child, collect)
      }
      collect(node.arguments[0])
      count += node.arguments[1].elements.filter((dep) => {
        const name = rootName(dep)
        return name !== null && !read.has(name)
      }).length
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return count
}

export function collectMobileReactCompilerHazards(root = process.cwd()) {
  const parsed = [...readTrackedSources(root, SCAN_ROOTS, isScannedMobilePath)].map(
    ([rel, text]) => ({ rel, sf: parseSource(rel, text) })
  )
  // Exported wrappers per module, iterated until no module gains one.
  const wrappersByModule = new Map()
  const liveNames = new Map()
  for (let grew = true; grew;) {
    grew = false
    for (const { rel, sf } of parsed) {
      const names = localWrappers(sf, liveImports(sf, rel, wrappersByModule))
      liveNames.set(rel, names)
      const exported = [...names].filter((name) => isExported(sf, name))
      const id = stripExtension(rel)
      const known = wrappersByModule.get(id) ?? new Set()
      if (exported.some((name) => !known.has(name))) {
        wrappersByModule.set(id, new Set([...known, ...exported]))
        grew = true
      }
    }
  }
  const counts = new Map()
  for (const { rel, sf } of parsed) {
    const calls = liveCalls(sf, liveNames.get(rel))
    const count =
      calls.filter((call) => {
        const owner = owningReactFunction(call)
        return owner !== null && evaluatesDuringRender(call, owner)
      }).length +
      liveGetters(calls).size +
      unreadMemoDeps(sf) +
      findSourceHazards(rel, sf.text).length
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'mobile-react-compiler-hazard',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectMobileReactCompilerHazards,
      unit: 'React Compiler hazard(s): render-path theme/language reads or unread memo deps',
      fix: [
        'Read the hook in the component and pass it down: useMobileColors() for colors,',
        'useThemedStyles(sheet) for styles, useMobileTranslation() for t, useMobileUiLocale()',
        'for the locale, useMobileColorScheme() for the scheme. A memo dep the callback never',
        'reads: recomputeOn([dep], () => ...) from mobile/src/hooks/recompute-on.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
