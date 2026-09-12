import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Bans the escapes that would make the typed boundary decorative.
 *
 * An operation's whole claim is that a reply arrives as a declared type because a reader
 * decoded it. `as`, `any` and a `@ts-` suppression each produce the same declared type without
 * the decode, so one of them anywhere in an operation implementation buys back exactly the
 * drift the contract removed — and it buys it silently, since the code still compiles and the
 * types still read as validated.
 *
 * The fenced region includes the operation API, contract and result-reader factory, plus
 * non-test files importing them and files that re-export a
 * file that is (transitively). Step 4's operation modules therefore land inside the fence the
 * moment they are written, with nothing to remember.
 *
 * What this does NOT catch, all accepted:
 *   - A lying reader. `z.unknown()` or a schema looser than the reply decodes anything, and no
 *     syntax check can tell a permissive schema from a wrong one.
 *   - Structural laundering: a helper in an unfenced module that returns the wrong type
 *     honestly, which the operation then consumes without a cast.
 *   - `!` non-null assertions, and the widening that an untyped intermediate variable gives
 *     you for free.
 *   - A screen. Screens are outside the region by design until they hold an operation; the
 *     raw-port inventory is what governs them.
 */

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
const scannedRoots = ['app', 'src'].map((directory) => join(mobileRoot, directory))
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])
const transportRoot = join(mobileRoot, 'src', 'transport')

/** Importing any of these is what makes a file an operation implementation. */
const REGION_SEEDS = new Set(
  ['rpc-operation', 'rpc-operation-contract', 'rpc-operation-result-reader'].map((name) =>
    join(transportRoot, name)
  )
)

export type RpcOperationEscape = 'assertion' | 'any' | 'suppression'

type CastFenceException = {
  readonly file: string
  readonly allows: readonly RpcOperationEscape[]
}

/**
 * The modules that own the `unknown` → declared-type transition, so the erasure has to land
 * somewhere. Held as data, per escape kind, so an exception cannot quietly widen into the
 * others. Every entry is also checked for staleness.
 */
const CAST_FENCE_EXCEPTIONS: readonly CastFenceException[] = [
  // The interpreter. Its casts re-apply type parameters that `AnyRpcOperation` erased on the
  // way in; none of them invents a shape the reader did not already produce.
  { file: 'src/transport/rpc-operation.ts', allows: ['assertion'] },
  // The reader factory. `safeParse` returns the schema's own output type as `unknown`.
  { file: 'src/transport/rpc-operation-result-reader.ts', allows: ['assertion'] },
  // Nothing but suppressions: every directive in it is an assertion that tsc still rejects
  // the thing above it, which is the compile fence's entire mechanism.
  { file: 'src/transport/rpc-operation-compile-fence.ts', allows: ['suppression'] }
]

// Text, not AST: a suppression is a comment, and comments are not nodes. A directive spelled
// inside a string literal therefore reads as one — which fails closed.
const SUPPRESSION = /@ts-(?:expect-error|ignore|nocheck)\b/

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

function resolvedSpecifier(path: string, node: ts.Node | undefined): string | null {
  if (!node || !ts.isStringLiteral(node) || !node.text.startsWith('.')) {
    return null
  }
  return resolve(path, '..', node.text)
}

/** `as const` narrows a literal; it declares nothing the value was not already. */
function isConstAssertion(node: ts.AsExpression): boolean {
  return (
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'const'
  )
}

export function rpcOperationEscapes(path: string, source: string): RpcOperationEscape[] {
  const found: RpcOperationEscape[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) && !isConstAssertion(node)) ||
      ts.isTypeAssertionExpression(node)
    ) {
      found.push('assertion')
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      found.push('any')
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  if (SUPPRESSION.test(source)) {
    found.push('suppression')
  }
  return [...new Set(found)].sort()
}

/** Imports and re-exports that make the importer part of the operation region. */
function moduleEdges(path: string, source: string): { imports: string[]; reExports: string[] } {
  const imports: string[] = []
  const reExports: string[] = []
  for (const statement of parse(path, source).statements) {
    if (ts.isImportDeclaration(statement)) {
      const target = resolvedSpecifier(path, statement.moduleSpecifier)
      if (target) {
        imports.push(target)
      }
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const target = resolvedSpecifier(path, statement.moduleSpecifier)
      if (target) {
        imports.push(target)
        reExports.push(target)
      }
    }
  }
  return { imports, reExports }
}

const scanned = scannedRoots
  .flatMap(sourceFiles)
  .filter((path) => sourceExtensions.has(extname(path)))
  .filter((path) => !/\.test\.tsx?$/.test(path))

const sources = new Map(scanned.map((path) => [path, readFileSync(path, 'utf8')] as const))
const edges = new Map([...sources].map(([path, source]) => [path, moduleEdges(path, source)]))

/** Modules are keyed without their extension, the way a relative specifier resolves. */
function moduleKey(path: string): string {
  return path.replace(/\.[jt]sx?$/, '')
}

const region = new Set(scanned.filter((path) => REGION_SEEDS.has(moduleKey(path))))
for (const [path, { imports }] of edges) {
  if (imports.some((target) => REGION_SEEDS.has(target))) {
    region.add(path)
  }
}
// Fixpoint over re-export edges: a barrel that re-exports an operation module is in the fence
// too, which is where a cast would otherwise sit unwatched between definition and screen.
for (let changed = true; changed;) {
  changed = false
  const members = new Set([...region].map(moduleKey))
  for (const [path, { reExports }] of edges) {
    if (!region.has(path) && reExports.some((target) => members.has(target))) {
      region.add(path)
      changed = true
    }
  }
}

const relativeRegion = [...region].map((path) =>
  relative(mobileRoot, path).split(/[/\\]/).join('/')
)

describe('RPC operation cast fence', () => {
  const probe = join(mobileRoot, 'src', 'transport', 'probe.ts')

  it('recognizes each escape and leaves honest code alone', () => {
    expect(rpcOperationEscapes(probe, 'const v = raw as WorkspaceRows')).toEqual(['assertion'])
    expect(rpcOperationEscapes(probe, 'const v = raw as unknown as WorkspaceRows')).toEqual([
      'assertion'
    ])
    expect(rpcOperationEscapes(probe, 'const v: any = raw')).toEqual(['any'])
    expect(rpcOperationEscapes(probe, 'function f(raw: any) {}')).toEqual(['any'])
    expect(rpcOperationEscapes(probe, 'const v = raw as any')).toEqual(['any', 'assertion'])
    expect(rpcOperationEscapes(probe, '// @ts-expect-error\nconst v = raw')).toEqual([
      'suppression'
    ])
    expect(rpcOperationEscapes(probe, '// @ts-ignore\nconst v = raw')).toEqual(['suppression'])
    expect(rpcOperationEscapes(probe, "const v = ['a'] as const")).toEqual([])
    expect(rpcOperationEscapes(probe, 'const v = read(raw)')).toEqual([])
    expect(rpcOperationEscapes(probe, 'const v = raw satisfies WorkspaceRows')).toEqual([])
    expect(rpcOperationEscapes(probe, 'const v = value!')).toEqual([])
  })

  it('puts every operation module in the fenced region', () => {
    for (const file of [
      'src/transport/rpc-operation.ts',
      'src/transport/rpc-operation-contract.ts',
      'src/transport/rpc-operation-test-families.ts',
      'src/transport/rpc-operation-compile-fence.ts',
      'src/transport/rpc-operation-result-reader.ts',
      'src/transport/rpc-incompatible-reply-error.ts'
    ]) {
      expect(relativeRegion, `${file} must be fenced`).toContain(file)
    }
    // A screen that only holds a client is governed by the raw-port inventory, not by this.
    expect(relativeRegion).not.toContain('src/transport/rpc-client.ts')
  })

  it('has no operation module casting, widening or suppressing its way to a type', () => {
    const allowed = new Map(CAST_FENCE_EXCEPTIONS.map((entry) => [entry.file, entry.allows]))
    const offenders = [...region]
      .map((path) => {
        const file = relative(mobileRoot, path).split(/[/\\]/).join('/')
        const escapes = rpcOperationEscapes(path, sources.get(path) ?? '')
        const permitted = allowed.get(file) ?? []
        return { file, escapes: escapes.filter((escape) => !permitted.includes(escape)) }
      })
      .filter((entry) => entry.escapes.length > 0)
      .map((entry) => `${entry.file}: ${entry.escapes.join(', ')}`)
      .sort()

    expect(
      offenders,
      'Decode the reply with a reader instead. An operation that asserts its own result type is not typed.'
    ).toEqual([])
  })

  it('has no stale cast-fence exception', () => {
    const stale = CAST_FENCE_EXCEPTIONS.flatMap((entry) => {
      const path = join(mobileRoot, entry.file)
      if (!region.has(path)) {
        return [`${entry.file}: no longer in the fenced region`]
      }
      const escapes = rpcOperationEscapes(path, sources.get(path) ?? '')
      return entry.allows
        .filter((escape) => !escapes.includes(escape))
        .map((escape) => `${entry.file}: no longer uses '${escape}'`)
    })
    expect(stale, 'Narrow or delete the exception in rpc-operation-cast-fence.test.ts.').toEqual([])
  })
})
