import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  UNVALIDATED_RPC_REQUEST_PORT_OWNERS,
  UNVALIDATED_RPC_REQUEST_PORT_PENDING,
  type UnvalidatedRpcRequestPortEntry
} from './unvalidated-rpc-request-port-inventory'

/**
 * Ratchet for the raw RPC request port.
 *
 * `sendRequest` takes an unchecked method string and returns an envelope whose `result` is
 * `unknown`. Every screen that reaches it re-decides acceptance and decoding for itself, which
 * is the drift the RpcOperation contract exists to end. The port cannot be made unreachable by
 * the type system today: `RpcClient` structurally carries it, and ~190 files hold a client. So
 * the boundary is held as an inventory instead, and this test is what makes the inventory bind.
 *
 * Three failures, all of which mean "edit the list":
 *   - a file reaches the port and is on neither list,
 *   - a listed file no longer reaches it (stale entry — how allow-lists rot),
 *   - a listed file's reference count went up.
 *
 * What this does NOT catch, all accepted:
 *   - Reach laundered through a function type. A listed file can hand `client.sendRequest` to an
 *     unlisted one as a bare `(method: string) => Promise<RpcResponse>` and the receiver never
 *     names the port. Only two senders are named here; a third wrapper needs adding by hand.
 *   - Computed access — `client['send' + 'Request']` is not a literal in the AST.
 *   - Which method a listed file sends, or what it does with the reply. The count is a ceiling
 *     on how many times it reaches, nothing more.
 *   - Test files. `*.test.ts(x)` is not scanned: faking the port is how these suites work, and a
 *     test does not ship. A non-test file that fakes it (tsconfig excludes tests, so some do) is
 *     scanned and listed.
 * A compile-time fence would catch the first two. That needs `RpcClient` to stop carrying the
 * port, which needs the call sites migrated first — the thing this list is counting down.
 */

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
const scannedRoots = ['app', 'src'].map((directory) => join(mobileRoot, directory))
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])
const portModule = join(mobileRoot, 'src', 'transport', 'unvalidated-rpc-request-port')

/** The port and its own inventory are not offenders; the ratchet does not police itself. */
const SELF_FILES = new Set([
  'src/transport/unvalidated-rpc-request-port.ts',
  'src/transport/unvalidated-rpc-request-port-inventory.ts'
])

/** The coalescing second sender: same unchecked string in, same unread envelope out. */
const SECOND_SENDER = 'sendSingleFlightRequest'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return [path]
  })
}

function parse(path: string, source: string): ts.SourceFile {
  const extension = extname(path)
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function targetsPortModule(path: string, node: ts.Node | undefined): boolean {
  if (!node || !ts.isStringLiteral(node) || !node.text.startsWith('.')) {
    return false
  }
  return resolve(path, '..', node.text) === portModule
}

/** `client['sendRequest']` is one reach, not two: the element access already counted it. */
function isCountedElementAccessArgument(node: ts.Node): boolean {
  const parent: ts.Node | undefined = node.parent
  return (
    parent !== undefined &&
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node
  )
}

function declaresPortMember(node: ts.Node): boolean {
  if (
    !ts.isPropertySignature(node) &&
    !ts.isMethodSignature(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isPropertyDeclaration(node) &&
    !ts.isPropertyAssignment(node) &&
    !ts.isShorthandPropertyAssignment(node)
  ) {
    return false
  }
  const name = node.name
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'sendRequest'
}

/** How many times this file reaches the raw port directly. Comments never count: this is AST. */
export function rawRequestPortReferences(path: string, source: string): number {
  let references = 0
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'sendRequest') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'sendRequest') ||
      declaresPortMember(node) ||
      (ts.isStringLiteral(node) &&
        node.text === 'sendRequest' &&
        !isCountedElementAccessArgument(node)) ||
      (ts.isIdentifier(node) && node.text === SECOND_SENDER)
    ) {
      references += 1
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      references += targetsPortModule(path, node.moduleSpecifier) ? 1 : 0
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      targetsPortModule(path, node.arguments[0])
    ) {
      references += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return references
}

const inventory: readonly UnvalidatedRpcRequestPortEntry[] = [
  ...UNVALIDATED_RPC_REQUEST_PORT_OWNERS,
  ...UNVALIDATED_RPC_REQUEST_PORT_PENDING
]

const scanned = scannedRoots
  .flatMap(sourceFiles)
  .filter((path) => sourceExtensions.has(extname(path)))
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => relative(mobileRoot, path).split(/[/\\]/).join('/'))
  .filter((file) => !SELF_FILES.has(file))

const observed = new Map(
  scanned
    .map(
      (file) =>
        [
          file,
          rawRequestPortReferences(
            join(mobileRoot, file),
            readFileSync(join(mobileRoot, file), 'utf8')
          )
        ] as const
    )
    .filter(([, references]) => references > 0)
)

describe('unvalidated RPC request port boundary', () => {
  const probe = join(mobileRoot, 'src', 'transport', 'probe.ts')

  it('counts every shape that reaches the port', () => {
    expect(rawRequestPortReferences(probe, 'await client.sendRequest("worktree.ps", {})')).toBe(1)
    expect(rawRequestPortReferences(probe, 'const send = client.sendRequest')).toBe(1)
    expect(rawRequestPortReferences(probe, 'client["sendRequest"]("x")')).toBe(1)
    expect(rawRequestPortReferences(probe, "type A = Pick<RpcClient, 'sendRequest'>")).toBe(1)
    expect(rawRequestPortReferences(probe, "type A = RpcClient['sendRequest']")).toBe(1)
    expect(rawRequestPortReferences(probe, 'const c = { sendRequest: async () => reply }')).toBe(1)
    expect(rawRequestPortReferences(probe, 'interface C { sendRequest(m: string): void }')).toBe(1)
    expect(rawRequestPortReferences(probe, "if (name === 'sendRequest') { }")).toBe(1)
    expect(
      rawRequestPortReferences(probe, 'await sendSingleFlightRequest(c, h, "worktree.ps")')
    ).toBe(1)
    expect(
      rawRequestPortReferences(
        probe,
        "import { sendSingleFlightRequest } from './request-single-flight'"
      )
    ).toBe(1)
    expect(
      rawRequestPortReferences(
        probe,
        "import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'"
      )
    ).toBe(1)
    expect(
      rawRequestPortReferences(
        probe,
        "export type { SendRequestOptions } from './unvalidated-rpc-request-port'"
      )
    ).toBe(1)
    expect(
      rawRequestPortReferences(probe, "const m = await import('./unvalidated-rpc-request-port')")
    ).toBe(1)
    expect(rawRequestPortReferences(probe, 'a.sendRequest(1); b.sendRequest(2)')).toBe(2)
  })

  it('does not count prose or an unrelated sender', () => {
    expect(rawRequestPortReferences(probe, '// calls sendRequest under the hood')).toBe(0)
    expect(rawRequestPortReferences(probe, '/* sendRequest */ export const x = 1')).toBe(0)
    expect(rawRequestPortReferences(probe, 'await client.subscribe("terminal.stream", {})')).toBe(0)
    expect(rawRequestPortReferences(probe, "import type { RpcClient } from './rpc-client'")).toBe(0)
    expect(rawRequestPortReferences(probe, 'await runRpcOperation(client, op, {})')).toBe(0)
  })

  it('scans a plausible number of files', () => {
    // A broken root or extension filter would make every check below vacuously pass.
    expect(scanned.length).toBeGreaterThan(400)
    expect(observed.size).toBeGreaterThan(50)
  })

  it('lists each file once', () => {
    const seen = inventory.map((entry) => entry.file)
    expect(seen.filter((file, index) => seen.indexOf(file) !== index)).toEqual([])
  })

  it('has no unlisted file reaching the raw request port', () => {
    const listed = new Set(inventory.map((entry) => entry.file))
    const unlisted = [...observed.keys()].filter((file) => !listed.has(file))
    expect(
      unlisted,
      'New code must send through an RpcOperation. Nothing may be added to unvalidated-rpc-request-port-inventory.ts.'
    ).toEqual([])
  })

  it('has no stale inventory entry', () => {
    const stale = inventory.filter((entry) => !observed.has(entry.file))
    expect(
      stale.map((entry) => entry.file),
      'File no longer reaches the raw port — delete its line from unvalidated-rpc-request-port-inventory.ts.'
    ).toEqual([])
  })

  it('has no inventory entry whose file gained references', () => {
    const grown = inventory
      .filter((entry) => (observed.get(entry.file) ?? 0) > entry.references)
      .map(
        (entry) => `${entry.file}: listed ${entry.references}, found ${observed.get(entry.file)}`
      )
    expect(grown, 'The counts are a ceiling. Send the new call through an RpcOperation.').toEqual(
      []
    )
  })

  it('reports a count that has fallen so the entry can be lowered', () => {
    const overstated = inventory
      .filter(
        (entry) => observed.has(entry.file) && (observed.get(entry.file) ?? 0) < entry.references
      )
      .map(
        (entry) => `${entry.file}: listed ${entry.references}, found ${observed.get(entry.file)}`
      )
    expect(
      overstated,
      'Fewer references than listed — lower the count so the ratchet holds.'
    ).toEqual([])
  })
})
