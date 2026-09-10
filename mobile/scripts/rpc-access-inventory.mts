import { join } from 'node:path'
import ts from 'typescript'
import { createRpcAccessResolver } from './rpc-access-resolution.mts'
import { emit, files, root } from './rpc-artifact-io.mts'

type AccessKind = 'request' | 'subscribe'
type CallSite = { file: string; line: number; column: number; kind: AccessKind; method: string }
const paths = [...files(join(root, 'mobile/src')), ...files(join(root, 'mobile/app'))].filter(
  (file) => /\.[jt]sx?$/.test(file)
)
const config = ts.readConfigFile(join(root, 'mobile/tsconfig.json'), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'mobile'))
const program = ts.createProgram(
  paths.map((file) => join(root, file)),
  parsed.options
)
const calls: CallSite[] = []
const referenceFiles = new Set<string>()
let referenceCount = 0
const { entryKind, resolveKind, methods } = createRpcAccessResolver(
  program,
  paths.map((file) => join(root, file))
)
for (const file of paths) {
  const sf = program.getSourceFile(join(root, file))!
  const positions = new Set<number>()
  function add(node: ts.Node, kind: AccessKind, call?: ts.CallExpression): void {
    const start = node.getStart(sf)
    if (positions.has(start)) {
      return
    }
    positions.add(start)
    if (!call) {
      referenceCount++
      referenceFiles.add(file)
      return
    }
    const literals = methods(call.arguments[0])
    const location = sf.getLineAndCharacterOfPosition(start)
    calls.push({
      file,
      line: location.line + 1,
      column: location.character + 1,
      kind,
      // A resolved family is every literal the checker proves may reach this argument; an
      // unresolved call carries its callee text, which is what tells a listener from an RPC.
      method: literals.length
        ? literals.join('|')
        : `dynamic:${node.getText(sf).replace(/\s+/g, ' ')}`
    })
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
calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
const rows = calls.map(
  (call) => `${call.file}:${call.line}:${call.column} ${call.kind} ${call.method}`
)
emit('access-inventory', {
  schemaVersion: 2,
  scope: ['mobile/src', 'mobile/app'],
  summary: {
    callSites: calls.length,
    literalMethod: calls.filter((call) => !/[|:]/.test(call.method)).length,
    resolvedFamily: calls.filter((call) => call.method.includes('|')).length,
    unresolvedDynamic: calls.filter((call) => call.method.startsWith('dynamic:')).length,
    referenceOccurrences: referenceCount,
    referenceFileCount: referenceFiles.size,
    note: 'calls are `file:line:column kind method`, where method is one literal, a `|`-joined family the checker resolved, or `dynamic:<callee>` when it resolved nothing. References are bare occurrences of the `sendRequest`/`subscribe` token with no call attached; only their count and files are recorded.'
  },
  calls: rows,
  referenceFiles: [...referenceFiles].sort()
})
console.log(`access census: ${calls.length} call sites, ${referenceCount} token references`)
