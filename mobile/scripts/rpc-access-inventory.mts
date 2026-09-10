import { join } from 'node:path'
import ts from 'typescript'
import { createRpcAccessResolver } from './rpc-access-resolution.mts'
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
  (file) => /\.[jt]sx?$/.test(file)
)
const config = ts.readConfigFile(join(root, 'mobile/tsconfig.json'), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'mobile'))
const program = ts.createProgram(
  paths.map((file) => join(root, file)),
  parsed.options
)
const checker = program.getTypeChecker()
const entries: AccessEntry[] = []
const { entryKind, resolveKind, methods, calls } = createRpcAccessResolver(
  program,
  paths.map((file) => join(root, file))
)
for (const file of paths) {
  const sf = program.getSourceFile(join(root, file))!
  const positions = new Set<number>()
  function add(node: ts.Node, kind: AccessEntry['kind'], call?: ts.CallExpression): void {
    const start = node.getStart(sf)
    if (positions.has(start)) {
      return
    }
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
    if (!call) {
      base.descriptor = { kind: 'access-reference', methods: [] }
    } else if (literals.length > 1) {
      base.descriptor = { kind: 'caller-resolved', methods: literals }
    }
    if (call && base.method === 'dynamic' && !base.descriptor) {
      const parameter = checker.getResolvedSignature(call)?.parameters[0]
      const parameterType = parameter && checker.getTypeOfSymbolAtLocation(parameter, call)
      if (
        kind === 'subscribe' &&
        [
          'mobile/app/connection-log.tsx',
          'mobile/src/session/use-mobile-native-chat-terminal-stream.ts'
        ].includes(file)
      ) {
        base.descriptor = {
          kind: 'non-rpc-listener',
          methods: [],
          reason: 'store listener or terminal handle callback; raw RPC is inventoried at its sender'
        }
      } else if (
        kind === 'subscribe' &&
        parameterType &&
        !(
          parameterType.flags &
          (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.Any | ts.TypeFlags.Union)
        )
      ) {
        base.descriptor = { kind: 'non-rpc-listener', methods: [] }
      } else if (/\.test\./.test(file)) {
        base.descriptor = { kind: 'test-reference', methods: [] }
      } else if (file.startsWith('mobile/src/transport/')) {
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
      } else if (file.endsWith('/use-mobile-git-requests.ts')) {
        const descriptorSource = program.getSourceFile(
          join(root, 'mobile/src/source-control/mobile-git-operation-descriptors.ts')
        )!
        const literalMethods: string[] = []
        const collect = (part: ts.Node): void => {
          if (
            ts.isPropertyAssignment(part) &&
            part.name.getText() === 'method' &&
            ts.isStringLiteral(part.initializer)
          ) {
            literalMethods.push(part.initializer.text)
          }
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
      if (kind) {
        add(node.expression, kind, node)
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const kind = resolveKind(node)
      if (kind) {
        add(node, kind)
      }
    } else if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      const parent = node.parent
      if (!(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))) {
        const kind = ts.isIdentifier(node) ? resolveKind(node) : entryKind(node.text)
        if (kind) {
          add(node, kind)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
if (process.argv.includes('--require-no-dynamic-calls')) {
  const unresolved = entries.filter((entry) => entry.method === 'dynamic' && !entry.descriptor)
  if (unresolved.length) {
    throw new Error(
      `Dynamic calls lack descriptors:\n${unresolved.map((entry) => `${entry.file}:${entry.line} ${entry.symbol}`).join('\n')}`
    )
  }
}
const callEntries = entries.filter((entry) => entry.role === 'call')
emit('access-inventory', {
  schemaVersion: 1,
  scope: ['mobile/src', 'mobile/app'],
  excludes: [],
  summary: {
    total: entries.length,
    referencesAutoExempt: entries.length - callEntries.length,
    callsSingleLiteralMethod: callEntries.filter((entry) => entry.method !== 'dynamic').length,
    callsDynamicWithResolvedFamily: callEntries.filter(
      (entry) => entry.method === 'dynamic' && Boolean(entry.descriptor)
    ).length,
    callsDynamicUnresolved: callEntries.filter(
      (entry) => entry.method === 'dynamic' && !entry.descriptor
    ).length,
    referenceNote:
      "role 'reference' entries receive an empty access-reference descriptor unconditionally, before any family logic runs, so --require-no-dynamic-calls exempts every one of them by construction. They are occurrences of the token, not resolved call sites; only callsDynamicWithResolvedFamily counts resolution work.",
    transportExceptionNote:
      "descriptor.kind 'transport-exception' records the union of every method literal resolvable anywhere in the mobile tree. It is a sound over-approximation of what a transport port may forward, not the method set of that call site."
  },
  entries
})
console.log(
  `access census: ${entries.length} references in ${new Set(entries.map((entry) => entry.file)).size} files`
)
