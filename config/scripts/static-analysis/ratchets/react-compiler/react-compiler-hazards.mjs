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

function memoizedCallKind(node) {
  if (isStoreRead(node)) {
    return { kind: 'store-read', name: 'getState' }
  }
  const hook = calleeName(node.expression)
  return hook && HOOK_NAME.test(hook) ? { kind: 'hook', name: hook } : null
}

/** Hook calls and `getState()` reads the compiler placed inside a memo-cache guarded block. */
export function findMemoizedCalls(fileName, compiledCode) {
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
    const call = ts.isCallExpression(node) ? memoizedCallKind(node) : null
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
      if (isStoreRead(node)) {
        lines.add(lineOf(sourceFile, node))
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
  }
  return [...lines].sort((a, b) => a - b)
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
