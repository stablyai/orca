import ts from 'typescript'
import {
  MOBILE_TASKS_SOURCE_FILES,
  readMobileTasksSource
} from './mobile-tasks-source-family.test-support'

type RenderDefinition = {
  body: ts.Block
  sourceFile: ts.SourceFile
}

function parseSource(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readMobileTasksSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

function renderDefinitions(): Map<string, RenderDefinition> {
  const definitions = new Map<string, RenderDefinition>()
  for (const relativePath of MOBILE_TASKS_SOURCE_FILES) {
    const sourceFile = parseSource(relativePath)
    function visit(node: ts.Node): void {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        (node.name.text === 'MobileTasksLegacySurface' ||
          node.name.text.startsWith('renderMobileTasks')) &&
        node.body
      ) {
        definitions.set(node.name.text, { body: node.body, sourceFile })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return definitions
}

function returnedExpression(body: ts.Block): ts.Expression {
  const statement = body.statements.find(ts.isReturnStatement)
  if (!statement?.expression) {
    throw new Error('Mobile Tasks renderer has no return expression')
  }
  return statement.expression
}

function rendererName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) &&
    (node.expression.text === 'MobileTasksLegacySurface' ||
      node.expression.text.startsWith('renderMobileTasks'))
    ? node.expression.text
    : null
}

function normalizedJsxText(node: ts.JsxText, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim()
}

function appendRenderTokens(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  definitions: ReadonlyMap<string, RenderDefinition>,
  active: ReadonlySet<string>,
  tokens: string[]
): void {
  if (ts.isCallExpression(node)) {
    const name = rendererName(node)
    const definition = name ? definitions.get(name) : undefined
    if (name && definition) {
      if (active.has(name)) {
        throw new Error(`Recursive Mobile Tasks renderer: ${name}`)
      }
      appendRenderTokens(
        returnedExpression(definition.body),
        definition.sourceFile,
        definitions,
        new Set([...active, name]),
        tokens
      )
      return
    }
  }
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) {
    if (node.expression) {
      appendRenderTokens(node.expression, sourceFile, definitions, active, tokens)
    }
    return
  }
  if (
    ts.isAsExpression(node) &&
    ts.isStringLiteralLike(node.expression) &&
    node.expression.text === ' '
  ) {
    appendRenderTokens(node.expression, sourceFile, definitions, active, tokens)
    return
  }
  if (ts.isStringLiteralLike(node)) {
    tokens.push(`string:${JSON.stringify(node.text)}`)
    return
  }
  if (ts.isJsxText(node)) {
    const text = normalizedJsxText(node, sourceFile)
    if (text) {
      tokens.push(`text:${text}`)
    }
    return
  }
  if (ts.isIdentifier(node) || node.getChildCount(sourceFile) === 0) {
    tokens.push(`${ts.SyntaxKind[node.kind]}:${node.getText(sourceFile)}`)
    return
  }
  tokens.push(`open:${ts.SyntaxKind[node.kind]}`)
  ts.forEachChild(node, (child) =>
    appendRenderTokens(child, sourceFile, definitions, active, tokens)
  )
  tokens.push(`close:${ts.SyntaxKind[node.kind]}`)
}

export function readFlattenedMobileTasksRenderTokens(): string[] {
  const definitions = renderDefinitions()
  const root = definitions.get('MobileTasksLegacySurface')
  if (!root) {
    throw new Error('Missing MobileTasksLegacySurface renderer')
  }
  const tokens: string[] = []
  appendRenderTokens(
    returnedExpression(root.body),
    root.sourceFile,
    definitions,
    new Set(['MobileTasksLegacySurface']),
    tokens
  )
  return tokens
}
