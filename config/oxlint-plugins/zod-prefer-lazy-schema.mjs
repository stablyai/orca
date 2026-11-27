// Disallow eager module-load Zod schema construction (modeled on bun/zod-prefer-lazy-schema).
// Top-level Zod v4 schemas retain live objects/closures/Sets in V8 heap even when never parsed;
// wrap them in `lazyZodSchema(() => ...)` from `src/shared/schema/lazy-zod-schema` or `z.lazy(() => ...)`.

const ZOD_SOURCES = new Set(['zod', 'zod/v4', 'zod/v4-mini'])
const ZOD_NON_SCHEMA_PROPERTIES = new Set([
  'lazy',
  'globalRegistry',
  'registry',
  'config',
  'toJSONSchema',
  'compile',
  'locales',
  'core',
  'util'
])
const DERIVED_SCHEMA_METHODS = new Set([
  'extend',
  'omit',
  'pick',
  'partial',
  'required',
  'merge',
  'nullable',
  'optional',
  'array'
])
const SCHEMA_NAME_PATTERN = /(?:Schema|Params|Body)$/

function memberName(node) {
  if (node?.type !== 'MemberExpression') {
    return null
  }
  if (!node.computed && node.property?.type === 'Identifier') {
    return node.property.name
  }
  return node.property?.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : null
}

function unwrapChain(callNode) {
  let current = callNode
  let firstMethod = null
  while (current?.type === 'CallExpression' || current?.type === 'MemberExpression') {
    if (current.type === 'MemberExpression') {
      firstMethod = memberName(current)
      current = current.object
    } else {
      current = current.callee
    }
  }
  return { root: current, firstMethod }
}

function isOutermostCall(node) {
  let parent = node.parent
  while (parent) {
    if (parent.type === 'MemberExpression' && parent.object === node) {
      node = parent
      parent = parent.parent
      continue
    }
    if (parent.type === 'CallExpression' && parent.callee === node) {
      return false
    }
    break
  }
  return true
}

function createZodPreferLazySchemaRule(context) {
  const zodRoots = new Set()
  let functionDepth = 0
  let reportedCallDepth = 0

  const enterFn = () => {
    functionDepth += 1
  }
  const exitFn = () => {
    functionDepth -= 1
  }

  return {
    ImportDeclaration(node) {
      const source = node.source?.value
      if (typeof source !== 'string' || !ZOD_SOURCES.has(source)) {
        return
      }
      for (const specifier of node.specifiers ?? []) {
        if (
          specifier.type === 'ImportNamespaceSpecifier' ||
          specifier.type === 'ImportDefaultSpecifier'
        ) {
          if (specifier.local?.name) {
            zodRoots.add(specifier.local.name)
          }
        } else if (specifier.type === 'ImportSpecifier') {
          const imported = specifier.imported?.name ?? specifier.imported?.value
          if (imported === 'z' && specifier.local?.name) {
            zodRoots.add(specifier.local.name)
          }
        }
      }
    },
    FunctionDeclaration: enterFn,
    'FunctionDeclaration:exit': exitFn,
    FunctionExpression: enterFn,
    'FunctionExpression:exit': exitFn,
    ArrowFunctionExpression: enterFn,
    'ArrowFunctionExpression:exit': exitFn,
    CallExpression(node) {
      if (functionDepth > 0 || reportedCallDepth > 0 || !isOutermostCall(node)) {
        return
      }
      const { root, firstMethod } = unwrapChain(node)
      if (root?.type !== 'Identifier' || !firstMethod) {
        return
      }
      const isDirectZod = zodRoots.has(root.name) && !ZOD_NON_SCHEMA_PROPERTIES.has(firstMethod)
      const isDerivedSchema =
        !zodRoots.has(root.name) &&
        SCHEMA_NAME_PATTERN.test(root.name) &&
        DERIVED_SCHEMA_METHODS.has(firstMethod)
      if (!isDirectZod && !isDerivedSchema) {
        return
      }
      reportedCallDepth += 1
      node.__zodLazyReported = true
      context.report({
        node,
        message:
          'Avoid building Zod schemas at module load; wrap in `lazyZodSchema(() => ...)` from `src/shared/schema/lazy-zod-schema` (or `z.lazy(() => ...)`).'
      })
    },
    'CallExpression:exit'(node) {
      if (node.__zodLazyReported) {
        reportedCallDepth -= 1
      }
    }
  }
}

export default {
  meta: { name: 'zod-prefer-lazy-schema' },
  rules: {
    'prefer-lazy-schema': { create: createZodPreferLazySchemaRule }
  }
}
