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
const MOBILE_REACTIVE_HOOKS = new Set([
  'useMobileColorScheme',
  'useMobileColors',
  'useMobileTranslation',
  'useMobileUiLocale',
  'useThemedStyles'
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

// A plain module function that calls a live reader synchronously (directly, via a local helper,
// or via a module-level lookup table of thunks) returns live state too.
function readsSynchronously(node, fn) {
  for (let current = node.parent; current && current !== fn; current = current.parent) {
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

function liveModuleContainers(sf, names) {
  const containers = new Set()
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      let init = declaration.initializer
      while (
        init &&
        (ts.isParenthesizedExpression(init) ||
          ts.isAsExpression(init) ||
          ts.isSatisfiesExpression(init))
      ) {
        init = init.expression
      }
      if (
        ts.isIdentifier(declaration.name) &&
        init &&
        (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) &&
        liveCalls(init, names).length > 0
      ) {
        containers.add(declaration.name.text)
      }
    }
  }
  return containers
}

function readsContainerSynchronously(fn, containers) {
  if (containers.size === 0) {
    return false
  }
  let found = false
  const visit = (child) => {
    if (found) {
      return
    }
    if (
      ts.isCallExpression(child) &&
      (ts.isElementAccessExpression(child.expression) ||
        ts.isPropertyAccessExpression(child.expression)) &&
      ts.isIdentifier(child.expression.expression) &&
      containers.has(child.expression.expression.text) &&
      !isShadowed(child.expression.expression, child.expression.expression.text) &&
      readsSynchronously(child, fn)
    ) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(fn)
  return found
}

function functionReadsLiveSynchronously(fn, names, containers) {
  const localFns = new Map()
  const collectLocals = (child) => {
    if (child !== fn) {
      if (ts.isFunctionDeclaration(child) && child.name && child.body) {
        localFns.set(child.name.text, child)
      } else if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.initializer &&
        (ts.isArrowFunction(child.initializer) || ts.isFunctionExpression(child.initializer))
      ) {
        localFns.set(child.name.text, child.initializer)
      }
    }
    ts.forEachChild(child, collectLocals)
  }
  collectLocals(fn)
  const localLive = new Set(names)
  for (let grew = true; grew;) {
    grew = false
    for (const [localName, localFn] of localFns) {
      if (localLive.has(localName)) {
        continue
      }
      if (
        liveCalls(localFn, localLive).some((call) => readsSynchronously(call, localFn)) ||
        readsContainerSynchronously(localFn, containers)
      ) {
        localLive.add(localName)
        grew = true
      }
    }
  }
  return (
    liveCalls(fn, localLive).some((call) => readsSynchronously(call, fn)) ||
    readsContainerSynchronously(fn, containers)
  )
}

function localWrappers(sf, live) {
  const functions = moduleFunctions(sf)
  const names = new Set(live)
  for (let grew = true; grew;) {
    grew = false
    const containers = liveModuleContainers(sf, names)
    for (const [name, fn] of functions) {
      if (names.has(name) || /^(?:use[A-Z0-9]|[A-Z])/.test(name)) {
        continue
      }
      if (functionReadsLiveSynchronously(fn, names, containers)) {
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

// A discarded mobile subscription hook only triggers a re-render; React Compiler still serves
// cached values unless the hook's return value flows into render.
function discardedMobileHooks(sf) {
  let count = 0
  const visit = (node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      MOBILE_REACTIVE_HOOKS.has(node.expression.expression.text) &&
      owningReactFunction(node) !== null
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return count
}

function pascalFunctionNames(sf) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
      names.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /^[A-Z]/.test(node.name.text) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

// A component whose only output is another component's call has no JSX of its own.
function pascalOwner(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) {
      return current.name && /^[A-Z]/.test(current.name.text) ? current : null
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      return null
    }
  }
  return null
}

// A component called as a plain function during render runs its hooks in the caller, and the
// compiler memoizes the call like any value: a cache hit skips those hooks (React error #300).
function componentCallsDuringRender(sf, components) {
  let count = 0
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      components.has(node.expression.text) &&
      !isShadowed(node.expression, node.expression.text)
    ) {
      const owner = owningReactFunction(node) ?? pascalOwner(node)
      if (owner !== null && evaluatesDuringRender(node, owner)) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return count
}

function parameterNames(name) {
  if (ts.isIdentifier(name)) {
    return [name.text]
  }
  // A rest element (...props) is a fresh object, so writing to it mutates nothing passed in.
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) || element.dotDotDotToken ? [] : parameterNames(element.name)
  )
}

// The nearest function whose own parameter binds `name`, so an inner helper's parameter of the same name is not the hook's.
function parameterBinder(node, name) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current)) &&
      current.parameters.some((param) => parameterNames(param.name).includes(name))
    ) {
      return current
    }
  }
  return null
}

// The compiler treats props and hook arguments as immutable: writing into one keeps its identity
// while its contents change, so memos keyed on it serve stale values. Return a new object instead.
function mutatedReactParams(sf) {
  let count = 0
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Object' &&
      node.expression.name.text === 'assign' &&
      node.arguments.length > 1 &&
      ts.isIdentifier(node.arguments[0])
    ) {
      const owner = owningReactFunction(node)
      if (owner !== null && parameterBinder(node, node.arguments[0].text) === owner) {
        count += 1
      }
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
  const components = new Set(parsed.flatMap(({ sf }) => [...pascalFunctionNames(sf)]))
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
      discardedMobileHooks(sf) +
      componentCallsDuringRender(sf, components) +
      // Test harnesses assemble their own fixture models; the app never runs them.
      (rel.includes('/test-support/') ? 0 : mutatedReactParams(sf)) +
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
      unit: 'React Compiler hazard(s): render-path theme/language reads, unread memo deps, components called as functions in render, or Object.assign onto a prop or hook argument',
      fix: [
        'Read the hook in the component and pass it down: useMobileColors() for colors,',
        'useThemedStyles(sheet) for styles, useMobileTranslation() for t, useMobileUiLocale()',
        'for the locale, useMobileColorScheme() for the scheme. A memo dep the callback never',
        'reads: recomputeOn([dep], () => ...) from mobile/src/hooks/recompute-on.',
        'A component called as a function: render it as JSX (<Component {...props} />).',
        'A mutated prop or hook argument (Object.assign(model, ...)): return { ...model, ... }.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
