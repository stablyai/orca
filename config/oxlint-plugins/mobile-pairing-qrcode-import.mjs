const MESSAGE =
  "qrcode is only reachable from mobile pairing. Use `import type` plus `await import('qrcode')` so startup does not parse its bundle."

function hasRuntimeImport(node) {
  if (node.importKind === 'type') {
    return false
  }
  return (
    node.specifiers.length === 0 ||
    node.specifiers.some((specifier) => specifier.importKind !== 'type')
  )
}

export default {
  meta: { name: 'mobile-pairing' },
  rules: {
    'no-eager-qrcode-import': {
      create(context) {
        return {
          ImportDeclaration(node) {
            if (node.source?.value === 'qrcode' && hasRuntimeImport(node)) {
              context.report({ node, message: MESSAGE })
            }
          }
        }
      }
    }
  }
}
