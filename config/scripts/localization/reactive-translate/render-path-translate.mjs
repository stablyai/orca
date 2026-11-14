import path from 'node:path'
import ts from 'typescript-api'

// Shared by the reactive-translate codemod, helper analysis and ratchet so all three agree on
// which translate()/getIntlLocale() calls run during a component or hook render.

export const SCAN_ROOT = 'src/renderer/src'
export const I18N_FUNCTIONS = ['translate', 'getIntlLocale']

// Callbacks that run after render (or only on mount): their translate() reads the live language
// when invoked, and adding `t` to their deps would re-run effects or change callback identity.
const DEFERRED_CALLBACK_HOOKS = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
  'useCallback',
  'useEffectEvent',
  'useImperativeHandle',
  'useState',
  'useReducer',
  'useSyncExternalStore',
  'startTransition'
])
const MEMO_HOOKS = new Set(['useMemo'])
const HOOK_NAME = /^use[A-Z0-9]/
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9_$]*$/
const COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef'])

// The hooks' own module reads the module functions by design.
const HOOK_SOURCES = new Set([`${SCAN_ROOT}/i18n/use-translate.ts`])

export function isScannedRendererPath(rel) {
  return (
    !HOOK_SOURCES.has(rel) &&
    rel.startsWith(`${SCAN_ROOT}/`) &&
    /\.tsx?$/.test(rel) &&
    !rel.endsWith('.d.ts') &&
    !/\.(?:test|spec|fixture|stories)\.tsx?$/.test(rel) &&
    !rel.includes('/__tests__/') &&
    !rel.includes('/test-support/')
  )
}

export function parseSource(fileName, text) {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

const I18N_MODULE = `${SCAN_ROOT}/i18n/i18n`

/** Whether an import specifier in `fileName` names the renderer i18n module. */
export function isI18nModuleSpecifier(fileName, specifier) {
  if (specifier === '@/i18n/i18n' || specifier === '@renderer/i18n/i18n') {
    return true
  }
  return (
    specifier.startsWith('.') &&
    path.posix.normalize(path.posix.join(path.posix.dirname(fileName), specifier)) === I18N_MODULE
  )
}

/** Local names bound to the renderer i18n exports, plus their import declarations. */
export function findI18nImports(sf) {
  const locals = new Map()
  const declarations = []
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isI18nModuleSpecifier(sf.fileName, statement.moduleSpecifier.text)
    ) {
      continue
    }
    declarations.push(statement)
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause.isTypeOnly) {
      continue
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (I18N_FUNCTIONS.includes(imported) && !element.isTypeOnly) {
        locals.set(element.name.text, imported)
      }
    }
  }
  return { locals, declarations }
}

export function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function unwrapExpressionParent(node) {
  let current = node
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent
  }
  return current
}

/** `foo`, `React.foo` or `x.foo` callee name. */
export function calleeName(call) {
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    return callee.text
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return callee.name.text
  }
  return null
}

/** The hook call a function is passed to directly, e.g. useMemo(() => ...). */
export function enclosingHookCall(fn) {
  const outer = unwrapExpressionParent(fn)
  const parent = outer.parent
  if (parent && ts.isCallExpression(parent) && parent.arguments.includes(outer)) {
    return parent
  }
  return null
}

/** Declared name of a function, following `const X = memo(function ...)` style wrappers. */
export function functionName(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) {
    return fn.name.text
  }
  let outer = unwrapExpressionParent(fn)
  // memo(forwardRef((props, ref) => ...)) and friends.
  while (
    outer.parent &&
    ts.isCallExpression(outer.parent) &&
    COMPONENT_WRAPPERS.has(calleeName(outer.parent) ?? '') &&
    outer.parent.arguments[0] === outer
  ) {
    outer = unwrapExpressionParent(outer.parent)
  }
  const parent = outer.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  if (parent && ts.isExportAssignment(parent)) {
    return 'default'
  }
  return null
}

function isWrappedComponent(fn) {
  const outer = unwrapExpressionParent(fn)
  const parent = outer.parent
  return Boolean(
    parent &&
    ts.isCallExpression(parent) &&
    COMPONENT_WRAPPERS.has(calleeName(parent) ?? '') &&
    parent.arguments[0] === outer
  )
}

function containsJsx(node) {
  let found = false
  const visit = (child) => {
    if (found) {
      return
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

const REACT_RETURN_TYPE = /\b(?:JSX\.Element|ReactNode|ReactElement|ReactPortal)\b/

/** 'component' | 'hook' | null for a function node. */
export function reactFunctionKind(fn) {
  if (
    !(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) ||
    !fn.body
  ) {
    return null
  }
  const name = functionName(fn)
  if (name && HOOK_NAME.test(name)) {
    return 'hook'
  }
  if (isWrappedComponent(fn)) {
    return 'component'
  }
  if (!name || !(COMPONENT_NAME.test(name) || name === 'default')) {
    return null
  }
  if (fn.type && REACT_RETURN_TYPE.test(fn.type.getText())) {
    return 'component'
  }
  return containsJsx(fn.body) ? 'component' : null
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) {
    out.push(name.text)
    return out
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      bindingNames(element.name, out)
    }
  }
  return out
}

function statementDeclares(statement, name) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((decl) =>
      bindingNames(decl.name, []).includes(name)
    )
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return true
  }
  return false
}

/** Whether `scope` (a block-like node, function, catch or for statement) binds `name`. */
function scopeDeclares(scope, name) {
  if (isFunctionLike(scope)) {
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) {
      return true
    }
    return scope.parameters.some((param) => bindingNames(param.name, []).includes(name))
  }
  if (
    ts.isBlock(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  ) {
    return scope.statements.some((statement) => statementDeclares(statement, name))
  }
  if (ts.isCatchClause(scope)) {
    return Boolean(
      scope.variableDeclaration && bindingNames(scope.variableDeclaration.name, []).includes(name)
    )
  }
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((decl) => bindingNames(decl.name, []).includes(name))
  }
  return false
}

/** True when a local binding between `node` and the module scope shadows `name`. */
export function isShadowed(node, name) {
  for (let scope = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
    if (scopeDeclares(scope, name)) {
      return true
    }
  }
  return false
}

function isIdentifierReference(node) {
  const parent = node.parent
  if (!parent) {
    return true
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) {
    return false
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false
  }
  if (
    (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
    parent.propertyName === node
  ) {
    return false
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) {
    return false
  }
  return true
}

/** Every identifier reference or binding spelled `name` under `node`. */
export function identifierUses(node, name) {
  const uses = []
  const visit = (child) => {
    if (ts.isIdentifier(child) && child.text === name && isIdentifierReference(child)) {
      uses.push(child)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return uses
}

/** Nearest enclosing component or hook function, or null for module-level code. */
export function owningReactFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current) && reactFunctionKind(current)) {
      return current
    }
    if (ts.isClassLike(current)) {
      return null
    }
  }
  return null
}

/**
 * How a call inside `owner` executes: 'render' (rewritable as is), 'memo' (inside a useMemo
 * factory; rewriting needs `t` in its deps), 'param' (a parameter default) or 'deferred'
 * (effect/callback/initializer).
 */
export function classifyRenderContext(node, owner) {
  let context = 'render'
  let memoCall = null
  for (let current = node.parent; current && current !== owner; current = current.parent) {
    // Parameter defaults run before the body, where a hook binding would not exist yet.
    if (current.parent === owner && ts.isParameter(current)) {
      return { context: 'param', memoCall: null }
    }
    if (!isFunctionLike(current)) {
      continue
    }
    const hook = enclosingHookCall(current)
    const name = hook ? calleeName(hook) : null
    if (name && DEFERRED_CALLBACK_HOOKS.has(name)) {
      context = 'deferred'
      memoCall = null
    } else if (name && MEMO_HOOKS.has(name) && context !== 'deferred') {
      context = 'memo'
      memoCall = hook
    }
  }
  return { context, memoCall }
}

// Callbacks these run synchronously, so a closure passed to them runs during the render.
const SYNC_CALLBACK_METHODS = new Set([
  'map',
  'flatMap',
  'filter',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'sort',
  'toSorted',
  'from',
  'replace',
  'replaceAll'
])

function localFunctionName(fn) {
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    return fn.name.text
  }
  const outer = unwrapExpressionParent(fn)
  return outer.parent &&
    ts.isVariableDeclaration(outer.parent) &&
    ts.isIdentifier(outer.parent.name)
    ? outer.parent.name.text
    : null
}

/**
 * Whether a closure inside `owner` runs while `owner` renders: a useMemo factory, an IIFE, a
 * synchronous array/string callback, or a local function the render itself calls. Anything else
 * (props, handlers, stored callbacks) runs later and reads the live language when it does.
 */
function closureRunsDuringRender(fn, owner, depth) {
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken) {
    return false
  }
  const outer = unwrapExpressionParent(fn)
  const parent = outer.parent
  if (parent && ts.isCallExpression(parent)) {
    if (parent.expression === outer) {
      return true
    }
    if (parent.arguments.includes(outer)) {
      const name = calleeName(parent)
      return Boolean(name && (MEMO_HOOKS.has(name) || SYNC_CALLBACK_METHODS.has(name)))
    }
  }
  const name = localFunctionName(fn)
  if (!name || depth > 3) {
    return false
  }
  return identifierUses(owner, name).some(
    (identifier) =>
      ts.isCallExpression(identifier.parent) &&
      identifier.parent.expression === identifier &&
      runsDuringRender(identifier, owner, depth + 1)
  )
}

/** Whether `node` runs in `fn`'s body while it runs: only IIFEs and synchronous callbacks in between. */
export function runsSynchronouslyWithin(node, fn) {
  for (let current = node.parent; current && current !== fn; current = current.parent) {
    // A parameter default cannot read a parameter declared after it.
    if (current.parent === fn && ts.isParameter(current)) {
      return false
    }
    if (!isFunctionLike(current)) {
      continue
    }
    const outer = unwrapExpressionParent(current)
    const parent = outer.parent
    const synchronous =
      parent &&
      ts.isCallExpression(parent) &&
      (parent.expression === outer ||
        (parent.arguments.includes(outer) && SYNC_CALLBACK_METHODS.has(calleeName(parent) ?? '')))
    if (!synchronous || current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      return false
    }
  }
  return true
}

function runsDuringRender(node, owner, depth) {
  for (let current = node.parent; current && current !== owner; current = current.parent) {
    if (isFunctionLike(current) && !closureRunsDuringRender(current, owner, depth)) {
      return false
    }
  }
  return true
}

/** Whether a use inside `owner` is evaluated while it renders (see closureRunsDuringRender). */
export function evaluatesDuringRender(node, owner) {
  return (
    classifyRenderContext(node, owner).context !== 'deferred' && runsDuringRender(node, owner, 0)
  )
}

/** translate()/getIntlLocale() calls of a file, each with its owner and render context. */
export function collectI18nCalls(sf) {
  const { locals } = findI18nImports(sf)
  const calls = []
  if (locals.size === 0) {
    return { locals, calls }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      locals.has(node.expression.text) &&
      !isShadowed(node.expression, node.expression.text)
    ) {
      const owner = owningReactFunction(node)
      const { context, memoCall } = owner
        ? classifyRenderContext(node, owner)
        : { context: 'module', memoCall: null }
      calls.push({ node, fn: locals.get(node.expression.text), owner, context, memoCall })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { locals, calls }
}

/** Calls the ratchet counts: anything evaluated during a component/hook render. */
export function isRenderPathCall(call) {
  return call.owner !== null && call.context !== 'deferred'
}
