import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'

/**
 * The host-route patterns the mobile app navigates to, read from its navigation call sites.
 *
 * Call sites, not every `/h/...` string the sources contain: a route also appears in the screen
 * that mounts it, in a `pathname === ...` comparison and in a template type, and harvesting those
 * makes every declared route "reachable" through its own mount. A census built on that answers
 * "is this route declared", which it already knows, instead of "does anything hop to it".
 *
 * Resolved one step past the literal, because the two hops that matter are not written as one:
 * the files explorer is pushed as `{ pathname: descriptor.pathname }` and the preview as
 * `push(createMobileFilePreviewHref(...))`. So a local binding or a call is followed to the
 * function that returns the pathname. A target it still cannot read is reported rather than
 * dropped.
 */

const MOBILE_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)), 'mobile')

/** `router`/`navigation` methods, plus the host-list action that wraps one. */
const ROUTER_METHODS = new Set(['push', 'replace', 'navigate'])
const ROUTER_RECEIVERS = new Set(['router', 'navigation'])
const ACTION_NAVIGATORS = new Set(['navigateFromHostList'])

function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      found.push(path)
    }
  }
  return found
}

function each(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => each(child, visit))
}

/** Past the annotations a href picks up on its way to the call. */
function unwrap(node) {
  let current = node
  while (
    current !== undefined &&
    (ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/** A string or template as a pattern, each interpolation standing for one segment. */
function literalPattern(node) {
  const value = unwrap(node)
  if (value === undefined) {
    return null
  }
  if (ts.isStringLiteralLike(value)) {
    return value.text
  }
  if (ts.isTemplateExpression(value)) {
    return value.head.text + value.templateSpans.map((span) => `[p]${span.literal.text}`).join('')
  }
  return null
}

/** A host route with its query dropped and adjacent interpolations collapsed to one segment. */
function normalize(raw) {
  if (raw === null || !raw.startsWith('/h/')) {
    return null
  }
  return raw
    .split('?')[0]
    .replaceAll(/(?:\[p\])+/g, '[p]')
    .replace(/\/$/, '')
}

function nameOf(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null
}

function isNavigator(expression) {
  const name = nameOf(expression)
  if (name === null) {
    return false
  }
  if (ACTION_NAVIGATORS.has(name)) {
    return true
  }
  if (!ROUTER_METHODS.has(name) || !ts.isPropertyAccessExpression(expression)) {
    return false
  }
  return ROUTER_RECEIVERS.has(nameOf(expression.expression) ?? '')
}

/** A href written out: the string itself, or the `pathname` of an object literal. */
function writtenPathnames(node) {
  const found = new Set()
  const direct = normalize(literalPattern(node))
  if (direct !== null) {
    found.add(direct)
  }
  const value = unwrap(node)
  if (value === undefined || !ts.isObjectLiteralExpression(value)) {
    return found
  }
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'pathname') {
      continue
    }
    const pathname = normalize(literalPattern(property.initializer))
    if (pathname !== null) {
      found.add(pathname)
    }
  }
  return found
}

function parseSources() {
  return [...sourceFiles(join(MOBILE_ROOT, 'src')), ...sourceFiles(join(MOBILE_ROOT, 'app'))].map(
    (file) => ({
      file,
      source: ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )
    })
  )
}

/** Functions that return a host route, by name, so a `push(builder(...))` resolves. */
function routeBuilders(parsed) {
  const builders = new Map()
  for (const { source } of parsed) {
    each(source, (node) => {
      const name = declaredFunctionName(node)
      if (name === undefined) {
        return
      }
      const found = new Set()
      each(node, (inner) => {
        if (!ts.isReturnStatement(inner) || inner.expression === undefined) {
          return
        }
        for (const pathname of writtenPathnames(inner.expression)) {
          found.add(pathname)
        }
      })
      if (found.size > 0) {
        builders.set(name, [...found])
      }
    })
  }
  return builders
}

function declaredFunctionName(node) {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text
  }
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
    return undefined
  }
  const initializer = node.initializer
  if (initializer === undefined) {
    return undefined
  }
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? node.name.text
    : undefined
}

/** Local consts holding a host route, written out or built by one of the builders above. */
function localRouteBindings(source, builders) {
  const bound = new Map()
  each(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return
    }
    const initializer = unwrap(node.initializer)
    if (initializer === undefined) {
      return
    }
    const direct = normalize(literalPattern(initializer))
    if (direct !== null) {
      bound.set(node.name.text, [direct])
      return
    }
    if (!ts.isCallExpression(initializer)) {
      return
    }
    const built = builders.get(nameOf(initializer.expression) ?? '')
    if (built !== undefined) {
      bound.set(node.name.text, built)
    }
  })
  return bound
}

function resolveTarget(expression, builders, bound) {
  const found = writtenPathnames(expression)
  if (found.size > 0) {
    return found
  }
  const value = unwrap(expression)
  if (value === undefined) {
    return found
  }
  const indirect = ts.isCallExpression(value)
    ? builders.get(nameOf(value.expression) ?? '')
    : ts.isPropertyAccessExpression(value) &&
        value.name.text === 'pathname' &&
        ts.isIdentifier(value.expression)
      ? bound.get(value.expression.text)
      : ts.isIdentifier(value)
        ? bound.get(value.text)
        : undefined
  for (const pathname of indirect ?? []) {
    found.add(pathname)
  }
  if (found.size > 0 || !ts.isObjectLiteralExpression(value)) {
    return found
  }
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'pathname') {
      continue
    }
    for (const pathname of resolveTarget(property.initializer, builders, bound)) {
      found.add(pathname)
    }
  }
  return found
}

/**
 * Every host route the app navigates to, and the call sites whose target could not be read.
 *
 * `unresolved` is mostly navigation away from `/h` altogether (pairing, settings) and the shell's
 * own forwarding of a href it was handed; it is returned rather than swallowed so a new indirection
 * is visible instead of quietly shrinking the census.
 */
export function mobileAppNavigationTargets() {
  const parsed = parseSources()
  const builders = routeBuilders(parsed)
  const targets = new Set()
  const unresolved = []
  for (const { file, source } of parsed) {
    const bound = localRouteBindings(source, builders)
    each(source, (node) => {
      if (!ts.isCallExpression(node) || !isNavigator(node.expression)) {
        return
      }
      const argument = node.arguments[0]
      if (argument === undefined) {
        return
      }
      const found = resolveTarget(argument, builders, bound)
      if (found.size === 0) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        unresolved.push(`${file.slice(MOBILE_ROOT.length + 1)}:${line}`)
        return
      }
      for (const pathname of found) {
        targets.add(pathname)
      }
    })
  }
  return { targets: [...targets].sort(), unresolved }
}
