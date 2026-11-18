import ts from 'typescript-api'

function assertionTokens(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source
  )
  const tokens = []
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    tokens.push([scanner.getToken(), scanner.getTokenText()])
  }
  return JSON.stringify(tokens)
}

export function createExistingTypeAssertionMatcher(sources) {
  const assertions = new Set()
  for (const { file, source } of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    if (ast.parseDiagnostics.length > 0) {
      continue
    }
    function visit(node) {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        assertions.add(assertionTokens(node.getText(ast)))
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return (source) => assertions.has(assertionTokens(source))
}
