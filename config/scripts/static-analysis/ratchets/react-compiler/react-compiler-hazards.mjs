import ts from 'typescript-api'

// Code React Compiler accepts but runs differently than written. Source hazards are found in the
// module-level components and hooks the compiler's infer mode picks (by name), compiled or not, so
// a bailout fix can't expose one; hooks in memo blocks are read from the compiled output.

const COMPONENT_NAME = /^[A-Z]/
const HOOK_NAME = /^use[A-Z0-9]/
const WRAPPERS = new Set(['memo', 'forwardRef'])
const OPT_OUT_DIRECTIVES = new Set(['use no memo', 'use no forget'])

export const HAZARD_FIXES = {
  'void-read': [
    'React Compiler drops a bare `void x;` read, so it neither invalidates a memo nor forces layout.',
    'Memo invalidator: `useMemo(() => recomputeOn([tick], () => compute()), [tick])` from',
    '@/lib/recompute-on. Layout flush: `forceLayoutReflow(el)` from @/lib/force-layout-reflow.'
  ],
  'member-postfix-value': [
    'oxc React Compiler 0.152 compiles a member postfix update used as a value (`a[q.head++]`) as',
    'a prefix update. Read first, then update in its own statement: `const v = a[q.head]; q.head += 1`.'
  ],
  'opt-out-directive': [
    '"use no memo" silently opts the function out of React Compiler. Fix the pattern it hides.'
  ],
  'discarded-subscription': [
    'A discarded useSyncExternalStore result only forces a re-render; React Compiler still serves',
    'reads after it from cache. Keep the snapshot: `const version = useSyncExternalStore(...)` and',
    'read through `recomputeOn([version], () => read())` from @/lib/recompute-on, or return it.'
  ],
  'store-read-in-memo-block': [
    'React Compiler caches this render-time `store.getState()` snapshot on unrelated inputs, so it',
    'goes stale. Read it in the event handler or effect that uses it, or select it with a hook.'
  ],
  'virtualizer-in-memo-block': [
    'A TanStack virtualizer is one object mutated in place, so React Compiler serves rows, sizes or',
    'child elements cached on it after every scroll. Add the file to',
    'config/react-compiler-uncompiled-files.txt, owners that pass the virtualizer down included.'
  ],
  'live-read-in-memo-block': [
    'React Compiler caches this render-time read of module state (a provider runtime context key or a',
    'structured selection) on its arguments, so it misses the module-level change. Add the file to',
    'config/react-compiler-uncompiled-files.txt, or subscribe to the state so a change re-renders.'
  ],
  'hook-in-memo-block': [
    'React Compiler memoizes this hook call inside a cached block, so it runs only when the block',
    'recomputes (a conditional hook). Call the hook in its own top-level `const` and use the variable.'
  ]
}

function scriptKind(fileName) {
  return /\.[cm]?[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

export function parseModule(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName))
}

function isReactName(name) {
  return COMPONENT_NAME.test(name) || HOOK_NAME.test(name)
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null
}

function unwrap(expression) {
  let node = expression
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression
  }
  return node
}

/** Name the compiler infers for a module-scope function: its own, its binding's, or memo()'s. */
function reactFunctionName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  let parent = node.parent
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) {
    parent = parent.parent
  }
  if (ts.isCallExpression(parent) && WRAPPERS.has(calleeName(parent.expression) ?? '')) {
    parent = parent.parent
  }
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null
}

function isFunctionNode(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

/** Module-scope components and hooks of a parsed module, with their inferred names. */
export function listReactFunctions(sourceFile) {
  const found = []
  const visit = (node) => {
    if (isFunctionNode(node)) {
      const name = reactFunctionName(node)
      if (name && isReactName(name)) {
        found.push({ name, node })
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function isValueUse(node) {
  const parent = node.parent
  if (ts.isExpressionStatement(parent)) {
    return false
  }
  return !(ts.isForStatement(parent) && parent.incrementor === node)
}

function directiveText(statement) {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
    ? statement.expression.text
    : null
}

function bodyDirectives(fn) {
  if (!fn.body || !ts.isBlock(fn.body)) {
    return []
  }
  const directives = []
  for (const statement of fn.body.statements) {
    const text = directiveText(statement)
    if (text === null) {
      break
    }
    directives.push({ text, statement })
  }
  return directives
}

/** Hazards in a module's source: `{ kind, fn, line, text }`, one per occurrence. */
export function findSourceHazards(fileName, text) {
  // Every hazard needs one of these tokens; skipping the parse keeps the full scan fast.
  if (!/\bvoid\b|\+\+|--|use no (?:memo|forget)|useSyncExternalStore/.test(text)) {
    return []
  }
  const sourceFile = parseModule(fileName, text)
  const hazards = []
  const report = (kind, fn, node) =>
    hazards.push({
      kind,
      fn,
      line: lineOf(sourceFile, node),
      text: node.getText(sourceFile).split('\n')[0].slice(0, 100)
    })
  for (const statement of sourceFile.statements) {
    const directive = directiveText(statement)
    if (directive === null) {
      break
    }
    if (OPT_OUT_DIRECTIVES.has(directive)) {
      report('opt-out-directive', '(module)', statement)
    }
  }
  for (const { name, node } of listReactFunctions(sourceFile)) {
    for (const { text: directive, statement } of bodyDirectives(node)) {
      if (OPT_OUT_DIRECTIVES.has(directive)) {
        report('opt-out-directive', name, statement)
      }
    }
    const visit = (child) => {
      if (
        ts.isExpressionStatement(child) &&
        ts.isCallExpression(child.expression) &&
        calleeName(child.expression.expression) === 'useSyncExternalStore'
      ) {
        report('discarded-subscription', name, child)
      }
      if (ts.isExpressionStatement(child) && ts.isVoidExpression(child.expression)) {
        const operand = unwrap(child.expression.expression)
        if (
          ts.isIdentifier(operand) ||
          ts.isPropertyAccessExpression(operand) ||
          ts.isElementAccessExpression(operand)
        ) {
          report('void-read', name, child)
        }
      }
      if (
        ts.isPostfixUnaryExpression(child) &&
        (ts.isPropertyAccessExpression(unwrap(child.operand)) ||
          ts.isElementAccessExpression(unwrap(child.operand))) &&
        isValueUse(child)
      ) {
        report('member-postfix-value', name, child)
      }
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
  }
  return hazards
}

function compilerCacheNames(sourceFile) {
  const runtimeImports = new Set()
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /^react(?:-compiler-runtime|\/compiler-runtime)$/.test(statement.moduleSpecifier.text)
    ) {
      const bindings = statement.importClause?.namedBindings
      for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
        if ((element.propertyName ?? element.name).text === 'c') {
          runtimeImports.add(element.name.text)
        }
      }
    }
  }
  return runtimeImports
}

function readsCache(expression, caches) {
  let found = false
  const visit = (node) => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      caches.has(node.expression.text)
    ) {
      found = true
    }
    if (!found) {
      ts.forEachChild(node, visit)
    }
  }
  visit(expression)
  return found
}

function isStoreRead(node) {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'getState'
  )
}

function memoizedCallKind(node, liveReaders) {
  if (isStoreRead(node)) {
    return { kind: 'store-read', name: 'getState' }
  }
  const callee = calleeName(node.expression)
  if (callee && liveReaders.has(callee)) {
    return { kind: 'live-read', name: callee }
  }
  return callee && HOOK_NAME.test(callee) ? { kind: 'hook', name: callee } : null
}

/** Hook calls, `getState()` reads and live module-state reads the compiler placed inside a memo-cache guarded block. */
export function findMemoizedCalls(fileName, compiledCode, liveReaders = new Set()) {
  if (!compiledCode.includes('compiler-runtime')) {
    return []
  }
  const sourceFile = parseModule(fileName, compiledCode)
  const runtime = compilerCacheNames(sourceFile)
  if (runtime.size === 0) {
    return []
  }
  const found = new Map()
  const caches = new Set()
  const collect = (fn, node) => {
    if (isFunctionNode(node)) {
      return
    }
    const call = ts.isCallExpression(node) ? memoizedCallKind(node, liveReaders) : null
    // Nested guarded blocks are walked once per enclosing block; keying by node dedupes them.
    if (call) {
      found.set(node, { fn, ...call })
    }
    ts.forEachChild(node, (child) => collect(fn, child))
  }
  const visit = (fn, node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      runtime.has(node.initializer.expression.text)
    ) {
      caches.add(node.name.text)
    }
    if (ts.isIfStatement(node) && readsCache(node.expression, caches)) {
      collect(fn, node.thenStatement)
    }
    const next = isFunctionNode(node) ? (reactFunctionName(node) ?? fn) : fn
    ts.forEachChild(node, (child) => visit(next, child))
  }
  visit('(module)', sourceFile)
  return [...found.values()]
}

/** Hook calls the compiler placed inside a memo-cache guarded block: `{ fn, hook }`. */
export function findMemoizedHookCalls(fileName, compiledCode) {
  return findMemoizedCalls(fileName, compiledCode)
    .filter(({ kind }) => kind === 'hook')
    .map(({ fn, name }) => ({ fn, hook: name }))
}

/** `getState()` calls the compiler placed inside a memo-cache guarded block: `{ fn }`. */
export function findMemoizedStoreReads(fileName, compiledCode) {
  return findMemoizedCalls(fileName, compiledCode)
    .filter(({ kind }) => kind === 'store-read')
    .map(({ fn }) => ({ fn }))
}

/** Source lines of render-time `getState()` calls in `fnName`; a useMemo/callback read is excluded. */
export function renderStoreReadLines(fileName, text, fnName) {
  return renderCallLines(fileName, text, fnName, isStoreRead)
}

/** Source lines of render-time calls to `callee` in `fnName`; a useMemo/callback call is excluded. */
export function renderLiveReadLines(fileName, text, fnName, callee) {
  return renderCallLines(
    fileName,
    text,
    fnName,
    (node) => ts.isCallExpression(node) && calleeName(node.expression) === callee
  )
}

function renderCallLines(fileName, text, fnName, matches) {
  const sourceFile = parseModule(fileName, text)
  const lines = new Set()
  for (const { name, node: root } of listReactFunctions(sourceFile)) {
    if (name !== fnName) {
      continue
    }
    const visit = (node) => {
      if (node !== root && isFunctionNode(node)) {
        return
      }
      if (matches(node)) {
        lines.add(lineOf(sourceFile, node))
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
  }
  return [...lines].sort((a, b) => a - b)
}

// Reads of module-level state that changes without a React update; a cache keyed on props keeps the old value.
export const LIVE_MODULE_READERS = [
  // Both fold in providerRuntimeSessionGeneration (lib/provider-runtime-context.ts).
  'getProviderRuntimeContextKey',
  'getEnvironmentRuntimeContextKey',
  // Both read the selection lifetime registry in structured-agent-session-selection-controller.ts.
  'structuredSessionSelectionAuthority',
  'structuredSessionSelectionController'
]

function moduleFunctionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text
  }
  const parent = node.parent
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    ts.isVariableStatement(parent.parent?.parent)
    ? parent.name.text
    : null
}

/** Module-scope plain functions whose own body calls a live reader, so their result is live too. */
export function findLiveReadWrappers(fileName, text, readers) {
  if (![...readers].some((reader) => text.includes(reader))) {
    return []
  }
  const sourceFile = parseModule(fileName, text)
  const wrappers = []
  for (const statement of sourceFile.statements) {
    const candidates = ts.isFunctionDeclaration(statement)
      ? [statement]
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations
            .map((declaration) => declaration.initializer && unwrap(declaration.initializer))
            .filter((init) => init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        : []
    for (const fn of candidates) {
      const name = moduleFunctionName(fn)
      if (!name || isReactName(name) || readers.has(name)) {
        continue
      }
      let calls = false
      const visit = (node) => {
        if (calls || (node !== fn && isFunctionNode(node))) {
          return
        }
        if (ts.isCallExpression(node) && readers.has(calleeName(node.expression) ?? '')) {
          calls = true
          return
        }
        ts.forEachChild(node, visit)
      }
      visit(fn)
      if (calls) {
        wrappers.push(name)
      }
    }
  }
  return wrappers
}

/** Source lines of `hook` calls in `fnName` that sit inside a larger expression. */
export function hookCallLines(fileName, text, fnName, hook) {
  const sourceFile = parseModule(fileName, text)
  const roots = listReactFunctions(sourceFile)
    .filter(({ name }) => name === fnName)
    .map(({ node }) => node)
  const lines = new Set()
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      calleeName(node.expression) === hook &&
      !ts.isVariableDeclaration(node.parent) &&
      !ts.isExpressionStatement(node.parent)
    ) {
      lines.add(lineOf(sourceFile, node))
    }
    ts.forEachChild(node, visit)
  }
  for (const root of roots.length > 0 ? roots : [sourceFile]) {
    visit(root)
  }
  return lines.size > 0 ? [...lines].sort((a, b) => a - b) : ['?']
}

// A TanStack virtualizer is one object mutated in place, so a cache keyed on it never refreshes.
export const VIRTUALIZER_HOOKS = new Map([
  ['useVirtualizer', 'direct'],
  ['useWindowVirtualizer', 'direct']
])
const VIRTUALIZER_NAME = /^\w*[vV]irtualizer$/
const VIRTUALIZER_TYPE = /\bVirtualizer\s*</
// Bound methods: passing one (e.g. as a row ref) reads no virtualizer state.
const STABLE_VIRTUALIZER_METHODS = new Set(['measureElement', 'scrollToIndex', 'scrollToOffset'])

function virtualizerHookShape(expression, hooks) {
  const node = expression && unwrap(expression)
  return node && ts.isCallExpression(node)
    ? (hooks.get(calleeName(node.expression) ?? '') ?? null)
    : null
}

/** Hooks returning a virtualizer (`direct`) or an object with a `virtualizer` (`property`). */
export function findVirtualizerWrappers(fileName, text, hooks = VIRTUALIZER_HOOKS) {
  if (![...hooks.keys()].some((hook) => text.includes(hook))) {
    return []
  }
  const sourceFile = parseModule(fileName, text)
  const wrappers = []
  for (const { name, node } of listReactFunctions(sourceFile)) {
    if (!HOOK_NAME.test(name) || hooks.has(name)) {
      continue
    }
    const bound = new Set()
    let shape = null
    const visit = (child) => {
      if (child !== node && isFunctionNode(child)) {
        return
      }
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        virtualizerHookShape(child.initializer, hooks) === 'direct'
      ) {
        bound.add(child.name.text)
      }
      if (ts.isReturnStatement(child) && child.expression) {
        const value = unwrap(child.expression)
        if (
          (ts.isIdentifier(value) && bound.has(value.text)) ||
          virtualizerHookShape(value, hooks) === 'direct'
        ) {
          shape = 'direct'
        } else if (
          ts.isObjectLiteralExpression(value) &&
          value.properties.some(
            (p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'virtualizer'
          )
        ) {
          shape ??= 'property'
        }
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    if (shape) {
      wrappers.push({ name, shape })
    }
  }
  return wrappers
}

/** Prop and parameter names this module types as a Virtualizer. */
function virtualizerTypedNames(fileName, text) {
  const names = new Set()
  if (!VIRTUALIZER_TYPE.test(text)) {
    return names
  }
  const sourceFile = parseModule(fileName, text)
  const visit = (node) => {
    if (
      (ts.isPropertySignature(node) || ts.isParameter(node)) &&
      node.type &&
      ts.isIdentifier(node.name) &&
      VIRTUALIZER_TYPE.test(node.type.getText(sourceFile))
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

/** Cache blocks keyed on a virtualizer that read it or pass it as a JSX prop: `{ fn, text }`. */
export function findVirtualizerMemoFlows(
  fileName,
  sourceText,
  compiledCode,
  hooks = VIRTUALIZER_HOOKS
) {
  if (
    !compiledCode.includes('compiler-runtime') ||
    !(
      /[vV]irtualizer/.test(compiledCode) ||
      [...hooks.keys()].some((hook) => compiledCode.includes(hook))
    )
  ) {
    return []
  }
  const typed = virtualizerTypedNames(fileName, sourceText)
  const sourceFile = parseModule(fileName, compiledCode)
  const runtime = compilerCacheNames(sourceFile)
  if (runtime.size === 0) {
    return []
  }
  const caches = new Set()
  const bound = new Set()
  const isVirtualizer = (expression) => {
    const node = unwrap(expression)
    if (ts.isIdentifier(node)) {
      const name = node.text.replace(/_\d+$/, '')
      return bound.has(node.text) || VIRTUALIZER_NAME.test(name) || typed.has(name)
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text
      return VIRTUALIZER_NAME.test(name) || typed.has(name)
    }
    return false
  }
  const keyedOnVirtualizer = (condition) => {
    let keyed = false
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        (isVirtualizer(node.left) || isVirtualizer(node.right))
      ) {
        keyed = true
      }
      if (!keyed) {
        ts.forEachChild(node, visit)
      }
    }
    visit(condition)
    return keyed
  }
  const found = new Map()
  // Closures call the live virtualizer when they run; only render-time reads and props go stale.
  const collect = (fn, node) => {
    if (isFunctionNode(node)) {
      return
    }
    const passed =
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      isVirtualizer(node.initializer.expression)
    const read =
      ts.isPropertyAccessExpression(node) &&
      isVirtualizer(node.expression) &&
      !(STABLE_VIRTUALIZER_METHODS.has(node.name.text) && !ts.isCallExpression(node.parent))
    if (passed || read) {
      found.set(node, { fn, text: node.getText(sourceFile).split('\n')[0].slice(0, 100) })
      return
    }
    ts.forEachChild(node, (child) => collect(fn, child))
  }
  const visit = (fn, node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer)
      const shape = virtualizerHookShape(init, hooks)
      if (ts.isIdentifier(node.name)) {
        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          runtime.has(init.expression.text)
        ) {
          caches.add(node.name.text)
        } else if (shape === 'direct' || isVirtualizer(init)) {
          bound.add(node.name.text)
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = (element.propertyName ?? element.name).getText(sourceFile)
          if (ts.isIdentifier(element.name) && (key === 'virtualizer' || typed.has(key))) {
            bound.add(element.name.text)
          }
        }
      }
    }
    if (
      ts.isIfStatement(node) &&
      readsCache(node.expression, caches) &&
      keyedOnVirtualizer(node.expression)
    ) {
      collect(fn, node.thenStatement)
    }
    const next = isFunctionNode(node) ? (reactFunctionName(node) ?? fn) : fn
    ts.forEachChild(node, (child) => visit(next, child))
  }
  visit('(module)', sourceFile)
  return [...found.values()]
}
