import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'

/** Accepted rows are a keyed owner, so Record idioms silently lose their contents. */
export function violations(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const nodes = []
  const walk = (node) => {
    nodes.push(node)
    ts.forEachChild(node, walk)
  }
  walk(source)
  const aliases = new Map(
    nodes.filter(ts.isTypeAliasDeclaration).map((node) => [node.name.text, node.type])
  )
  const resolveType = (type, seen = new Set()) => {
    if (!type || !ts.isTypeReferenceNode(type) || seen.has(type.typeName.getText(source))) {
      return type
    }
    const name = type.typeName.getText(source)
    const alias = aliases.get(name)
    return alias ? resolveType(alias, new Set([...seen, name])) : type
  }
  const mapType = (input) => {
    const type = resolveType(input)
    if (!type) {
      return false
    }
    if (ts.isParenthesizedTypeNode(type)) {
      return mapType(type.type)
    }
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName.getText(source)
      return (
        name === 'AcceptedAgentStatuses' ||
        (['Map', 'ReadonlyMap'].includes(name) &&
          type.typeArguments?.[1]?.getText(source) === 'AgentStatusEntry')
      )
    }
    return /AppState\[['"]agentStatusByPaneKey['"]\]/.test(type.getText(source))
  }
  const parameterType = (parameter) => {
    if (parameter.type) {
      return parameter.type
    }
    const fn = parameter.parent
    if (!ts.isArrowFunction(fn)) {
      return undefined
    }
    let outer
    if (ts.isReturnStatement(fn.parent)) {
      for (let node = fn.parent.parent; node; node = node.parent) {
        if (ts.isFunctionLike(node)) {
          outer = node
          break
        }
      }
    } else if (ts.isArrowFunction(fn.parent) && fn.parent.body === fn) {
      outer = fn.parent
    }
    const returned = resolveType(outer?.type)
    return returned && ts.isFunctionTypeNode(returned)
      ? returned.parameters[fn.parameters.indexOf(parameter)]?.type
      : undefined
  }
  const scopes = new Map()
  const scopeOf = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isBlock(parent) || ts.isFunctionLike(parent) || ts.isSourceFile(parent)) {
        return parent
      }
    }
    return source
  }
  for (const node of nodes) {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const scope = scopeOf(node)
      if (!scopes.has(scope)) {
        scopes.set(scope, new Map())
      }
      scopes.get(scope).set(node.name.text, node)
    }
  }
  const collection = (node, seen = new Set()) => {
    if (!node || seen.has(node)) {
      return false
    }
    seen.add(node)
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node)
    ) {
      return collection(node.expression, seen)
    }
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === 'agentStatusByPaneKey'
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        node.operatorToken.kind
      )
    ) {
      return collection(node.left, seen)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'acceptedAgentStatuses'
    ) {
      return true
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['replace', 'capture', 'refresh'].includes(node.expression.name.text)
    ) {
      return collection(node.expression.expression, seen)
    }
    if (!ts.isIdentifier(node)) {
      return false
    }
    for (let scope = scopeOf(node); scope; scope = scope === source ? null : scopeOf(scope)) {
      const binding = scopes.get(scope)?.get(node.text)
      if (!binding) {
        continue
      }
      if (ts.isBindingElement(binding)) {
        return (binding.propertyName ?? binding.name).getText(source) === 'agentStatusByPaneKey'
      }
      if (ts.isParameter(binding)) {
        return mapType(parameterType(binding))
      }
      return mapType(binding.type) || collection(binding.initializer, seen)
    }
    return node.text === 'agentStatusByPaneKey'
  }
  const failures = []
  for (const node of nodes) {
    let operation
    if (ts.isElementAccessExpression(node) && collection(node.expression)) {
      operation = 'bracket access'
    }
    if (ts.isSpreadAssignment(node) && collection(node.expression)) {
      operation = 'object spread'
    }
    if (ts.isForInStatement(node) && collection(node.expression)) {
      operation = 'for-in'
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      collection(node.right)
    ) {
      operation = 'in'
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['Object', 'JSON'].includes(node.expression.expression.getText(source)) &&
      node.arguments.some((argument) => collection(argument))
    ) {
      operation = node.expression.getText(source)
    }
    if (operation) {
      failures.push(
        `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${operation} on accepted agent statuses; use keyed Map access`
      )
    }
  }
  return failures
}

export function collect(root = process.cwd()) {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'src/renderer/src',
      'tests'
    ],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => /\.[jt]sx?$/.test(file) && fs.existsSync(path.join(root, file)))
  return files.flatMap((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    return /agentStatusByPaneKey|AcceptedAgentStatuses|AgentStatusEntry|acceptedAgentStatuses/.test(
      text
    )
      ? violations(file, text)
      : []
  })
}
export function main() {
  const failures = collect()
  if (failures.length) {
    console.error(failures.join('\n'))
    return 1
  }
  console.log('agent-status-map ratchet OK')
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
