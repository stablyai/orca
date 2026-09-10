import { join } from 'node:path'
import ts from 'typescript'
import { emit, files, root } from './rpc-artifact-io.mts'

export type AccessEntry = {
  file: string
  line: number
  column: number
  symbol: string
  method: string
  kind: 'request' | 'subscribe'
  policy: string
  role: 'call' | 'reference'
  descriptor?: {
    kind: string
    methods: string[]
    owner?: string
    policyId?: string
    scenarioIds?: string[]
    reason?: string
  }
}
const paths = [...files(join(root, 'mobile/src')), ...files(join(root, 'mobile/app'))].filter(
  (file) => /\.[jt]sx?$/.test(file) && !/\.generated\./.test(file)
)
const config = ts.readConfigFile(join(root, 'mobile/tsconfig.json'), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'mobile'))
const program = ts.createProgram(
  paths.map((file) => join(root, file)),
  parsed.options
)
const checker = program.getTypeChecker()
const entries: AccessEntry[] = []
function entryKind(name: string | undefined): AccessEntry['kind'] | undefined {
  return name === 'sendRequest' ? 'request' : name === 'subscribe' ? 'subscribe' : undefined
}
function resolveKind(node: ts.Node, seen = new Set<ts.Node>()): AccessEntry['kind'] | undefined {
  if (seen.has(node)) return
  seen.add(node)
  if (ts.isPropertyAccessExpression(node)) return entryKind(node.name.text)
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return entryKind(node.argumentExpression.text)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'bind'
  )
    return resolveKind(node.expression.expression, seen)
  if (!ts.isIdentifier(node)) return
  const direct = entryKind(node.text)
  if (direct) return direct
  let symbol = checker.getSymbolAtLocation(node)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const kind = resolveKind(declaration.initializer, seen)
      if (kind) return kind
    }
    if (ts.isBindingElement(declaration))
      return entryKind(
        (declaration.propertyName ?? declaration.name).getText().replace(/['"]/g, '')
      )
  }
}
const calls: ts.CallExpression[] = []
for (const file of paths) {
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, walk)
  }
  walk(program.getSourceFile(join(root, file))!)
}
function methods(node: ts.Expression | undefined, seen = new Set<ts.Node>()): string[] {
  if (!node) return []
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (seen.has(node)) return []
  seen = new Set(seen).add(node)
  const type = checker.getTypeAtLocation(node)
  const types = type.isUnion() ? type.types : [type]
  if (types.every((item) => item.isStringLiteral()))
    return types.map((item) => (item as ts.StringLiteralType).value).sort()
  const symbol = checker.getSymbolAtLocation(node)
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer)
      return methods(declaration.initializer, seen)
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const binding = declaration.parent.parent
      if (ts.isVariableDeclaration(binding) && binding.initializer) {
        const key = (declaration.propertyName ?? declaration.name).getText()
        const target = checker.getSymbolAtLocation(binding.initializer)
        for (const param of target?.declarations ?? []) {
          if (!ts.isParameter(param) || !ts.isFunctionLike(param.parent)) continue
          const index = param.parent.parameters.indexOf(param)
          const values = calls
            .filter((call) => checker.getResolvedSignature(call)?.declaration === param.parent)
            .map((call) => call.arguments[index])
            .flatMap((arg) => {
              if (!arg || !ts.isObjectLiteralExpression(arg)) return []
              return arg.properties
                .filter((property) => property.name?.getText() === key)
                .flatMap((property) =>
                  ts.isPropertyAssignment(property)
                    ? methods(property.initializer, seen)
                    : ts.isShorthandPropertyAssignment(property)
                      ? methods(property.name, seen)
                      : []
                )
            })
          if (values.length) return [...new Set(values)].sort()
        }
      }
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration)
      for (const item of value?.declarations ?? [])
        if (ts.isParameter(item)) {
          const owner = item.parent
          if (ts.isFunctionLike(owner)) {
            const index = owner.parameters.indexOf(item)
            const values = calls
              .filter((call) => checker.getResolvedSignature(call)?.declaration === owner)
              .flatMap((call) => methods(call.arguments[index], seen))
            if (values.length) return [...new Set(values)].sort()
          }
        }
    }
    if (ts.isParameter(declaration)) {
      const owner = declaration.parent
      if (!ts.isFunctionLike(owner)) continue
      const index = owner.parameters.indexOf(declaration)
      const callerArgs = calls
        .filter((call) => checker.getResolvedSignature(call)?.declaration === owner)
        .map((call) => call.arguments[index])
      const resolved = callerArgs.map((arg) => methods(arg, seen))
      if (resolved.length && resolved.every((values) => values.length))
        return [...new Set(resolved.flat())].sort()
    }
  }
  return []
}
for (const file of paths) {
  const sf = program.getSourceFile(join(root, file))!
  const positions = new Set<number>()
  function add(node: ts.Node, kind: AccessEntry['kind'], call?: ts.CallExpression): void {
    const start = node.getStart(sf)
    if (positions.has(start)) return
    positions.add(start)
    const location = sf.getLineAndCharacterOfPosition(start)
    const literals = methods(call?.arguments[0])
    const base: AccessEntry = {
      file,
      line: location.line + 1,
      column: location.character + 1,
      symbol: node.getText(sf),
      method: literals.length === 1 ? literals[0] : 'dynamic',
      kind,
      policy: 'unclassified',
      role: call ? 'call' : 'reference'
    }
    if (!call) base.descriptor = { kind: 'access-reference', methods: [] }
    else if (literals.length > 1) base.descriptor = { kind: 'caller-resolved', methods: literals }
    if (call && base.method === 'dynamic' && !base.descriptor) {
      const parameter = checker.getResolvedSignature(call)?.parameters[0]
      const parameterType = parameter && checker.getTypeOfSymbolAtLocation(parameter, call)
      if (
        kind === 'subscribe' &&
        [
          'mobile/app/connection-log.tsx',
          'mobile/src/session/use-mobile-native-chat-terminal-stream.ts'
        ].includes(file)
      )
        base.descriptor = {
          kind: 'non-rpc-listener',
          methods: [],
          reason: 'store listener or terminal handle callback; raw RPC is inventoried at its sender'
        }
      else if (
        kind === 'subscribe' &&
        parameterType &&
        !(
          parameterType.flags &
          (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.Any | ts.TypeFlags.Union)
        )
      )
        base.descriptor = { kind: 'non-rpc-listener', methods: [] }
      else if (/\.test\./.test(file)) base.descriptor = { kind: 'test-reference', methods: [] }
      else if (file.startsWith('mobile/src/transport/'))
        base.descriptor = {
          kind: 'transport-exception',
          methods: [
            ...new Set(
              calls
                .filter((candidate) => resolveKind(candidate.expression) === kind)
                .flatMap((candidate) => methods(candidate.arguments[0]))
            )
          ].sort(),
          owner: 'Jinwoo',
          policyId: 'transport-forwarding',
          scenarioIds: ['transport:fulfilled', 'transport:refused', 'transport:rejection'],
          reason: 'transport port, below the operation boundary'
        }
      else if (file.endsWith('/use-mobile-git-requests.ts')) {
        const descriptorSource = program.getSourceFile(
          join(root, 'mobile/src/source-control/mobile-git-operation-descriptors.ts')
        )!
        const literalMethods: string[] = []
        const collect = (part: ts.Node): void => {
          if (
            ts.isPropertyAssignment(part) &&
            part.name.getText() === 'method' &&
            ts.isStringLiteral(part.initializer)
          )
            literalMethods.push(part.initializer.text)
          ts.forEachChild(part, collect)
        }
        collect(descriptorSource)
        base.descriptor = { kind: 'operation-descriptors', methods: literalMethods.sort() }
      }
    }
    entries.push(base)
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const kind = resolveKind(node.expression)
      if (kind) add(node.expression, kind, node)
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const kind = resolveKind(node)
      if (kind) add(node, kind)
    } else if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      const parent = node.parent
      if (!(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))) {
        const kind = ts.isIdentifier(node) ? resolveKind(node) : entryKind(node.text)
        if (kind) add(node, kind)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
if (process.argv.includes('--require-no-dynamic-calls')) {
  const unresolved = entries.filter((entry) => entry.method === 'dynamic' && !entry.descriptor)
  if (unresolved.length)
    throw new Error(
      `Dynamic calls lack descriptors:\n${unresolved.map((entry) => `${entry.file}:${entry.line} ${entry.symbol}`).join('\n')}`
    )
}
emit('access-inventory', {
  schemaVersion: 1,
  scope: ['mobile/src', 'mobile/app'],
  excludes: ['*.generated.*'],
  entries
})
console.log(
  `access census: ${entries.length} references in ${new Set(entries.map((entry) => entry.file)).size} files`
)
