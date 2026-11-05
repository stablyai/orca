// Inspect lazy bodies too: successful initialization alone can miss an external loaded on first use.
export async function preloadRuntimeImports(source) {
  const { default: ts } = await import('typescript-api')
  const ast = ts.createSourceFile(
    'preload.cjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const imports = new Set()
  function visit(node) {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      throw new Error('Sandbox preload must be a self-contained CommonJS artifact')
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error('Sandbox preload contains dynamic import')
    }
    if (ts.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent
      if (
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.arguments.length === 1 &&
        ts.isStringLiteral(parent.arguments[0])
      ) {
        imports.add(parent.arguments[0].text)
      } else if (!ts.isTypeOfExpression(parent)) {
        throw new Error('Sandbox preload contains indirect or dynamic require')
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ['require', 'createRequire', 'getBuiltinModule'].includes(node.name.text)
    ) {
      throw new Error('Sandbox preload contains an unsupported module loader')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...imports].sort()
}

const SANDBOX_PRELOAD_IMPORTS = new Set([
  'electron',
  'electron/common',
  'electron/renderer',
  'events',
  'node:events',
  'timers',
  'node:timers',
  'url',
  'node:url'
])

export async function verifySandboxPreloadImports(source) {
  const imports = await preloadRuntimeImports(source)
  const unsupported = imports.filter((name) => !SANDBOX_PRELOAD_IMPORTS.has(name))
  if (unsupported.length) {
    throw new Error(`Unsupported sandbox preload imports: ${unsupported.join(', ')}`)
  }
  return imports
}
