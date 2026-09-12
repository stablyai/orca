import ts from 'typescript-api'

const SPAWN_METHODS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync'])
const BIN_PATH = /(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/i

export function hasNodeModulesBinSpawn(contents) {
  const source = ts.createSourceFile(
    'script.mjs',
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const bindings = new Map()
  const calls = []
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializers = bindings.get(node.name.text) ?? []
      initializers.push(node.initializer)
      bindings.set(node.name.text, initializers)
    }
    if (ts.isCallExpression(node)) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  function name(node) {
    return ts.isIdentifier(node)
      ? node.text
      : ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ''
  }

  function paths(node, seen = new Set()) {
    if (!node || seen.has(node)) {
      return ['?']
    }
    const next = new Set(seen).add(node)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [node.text]
    }
    if (ts.isIdentifier(node)) {
      return (bindings.get(node.text) ?? []).flatMap((value) => paths(value, next))
    }
    if (ts.isParenthesizedExpression(node)) {
      return paths(node.expression, next)
    }
    if (ts.isConditionalExpression(node)) {
      return [...paths(node.whenTrue, next), ...paths(node.whenFalse, next)]
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce(
        (prefixes, span) => combine(prefixes, paths(span.expression, next), '', span.literal.text),
        [node.head.text]
      )
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return combine(paths(node.left, next), paths(node.right, next))
    }
    if (ts.isCallExpression(node) && ['join', 'resolve'].includes(name(node.expression))) {
      return node.arguments.reduce(
        (prefixes, arg) => combine(prefixes, paths(arg, next), '/'),
        ['']
      )
    }
    return ['?']
  }

  function combine(left, right, separator = '', suffix = '') {
    return (left.length ? left : ['?']).flatMap((prefix) =>
      (right.length ? right : ['?']).map((part) => `${prefix}${separator}${part}${suffix}`)
    )
  }

  return calls.some(
    (call) =>
      SPAWN_METHODS.has(name(call.expression)) &&
      paths(call.arguments[0]).some((value) => BIN_PATH.test(value))
  )
}
