import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'
import { readScenarios } from '../test-support/rpc-recording/scenario-input'
import { READY_STREAM_RELEASE_METHODS } from './rpc-client-server-subscription'
import { RPC_SUBSCRIPTION_SITES, type RpcSubscriptionSite } from './rpc-subscription-inventory'

/**
 * Makes the subscription inventory bind.
 *
 * Five failures, all of which mean "edit the list":
 *   - a file opens a stream and is not listed,
 *   - a listed file no longer opens one (stale entry — how allow-lists rot),
 *   - a listed file opens a different method than its entry claims,
 *   - the `ready-id` entries and the transport's release table name different methods,
 *   - a `recorded` entry names a family the scenario manifest does not have.
 *
 * The last one is what separates this from prose. A comment saying a stream is covered stays true
 * forever; an entry that has to resolve against `pilot-scenarios.json` stops being true the moment
 * the family is renamed or deleted.
 *
 * What this does NOT catch, all accepted:
 *   - A method that is not a string literal at the call site. `client.subscribe(method, …)` with a
 *     variable is invisible here, the same gap the raw-port ratchet accepts for a computed
 *     `sendRequest`. Every product site today spells its method.
 *   - Whether a `recorded` family's golden actually drives that file. `sites` in the manifest says
 *     so and no check ties the two together; that is one indirection further than this list is for.
 *   - Whether a wall is still real. A wall is prose by construction — it says why a recording
 *     cannot exist, and the only proof of the opposite is the recording.
 *   - `transport/` and `test-support/`, which implement and script the port rather than consuming
 *     it. A registry that forwards `subscribe` is not a call site.
 */

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
const repoRoot = resolve(mobileRoot, '..')
const scannedRoots = ['app', 'src'].map((directory) => join(mobileRoot, directory))
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])
/** The port's own implementation and the oracle that scripts it. Neither consumes a stream. */
const EXCLUDED_DIRECTORIES = ['src/transport/', 'src/test-support/']

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

/** Every method this file opens a stream on, in source order. */
export function subscribedMethods(path: string, source: string): string[] {
  const methods: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'subscribe'
    ) {
      const [method] = node.arguments
      if (method && ts.isStringLiteral(method)) {
        methods.push(method.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return methods
}

const scanned = scannedRoots
  .flatMap(censusSourceFiles)
  .filter((path) => sourceExtensions.has(extname(path)))
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => relative(mobileRoot, path).split(/[/\\]/).join('/'))
  .filter((file) => !EXCLUDED_DIRECTORIES.some((directory) => file.startsWith(directory)))

const observed = new Map(
  scanned
    .map(
      (file) =>
        [
          file,
          subscribedMethods(join(mobileRoot, file), readFileSync(join(mobileRoot, file), 'utf8'))
        ] as const
    )
    .filter(([, methods]) => methods.length > 0)
)

const families = new Set(
  readScenarios(join(repoRoot, 'mobile', 'rpc-foundation', 'pilot-scenarios.json')).scenarios.map(
    (scenario) => scenario.family
  )
)

function listedMethods(file: string): string[] {
  return RPC_SUBSCRIPTION_SITES.filter((site) => site.file === file).map((site) => site.method)
}

describe('RPC subscription boundary', () => {
  const probe = join(mobileRoot, 'src', 'session', 'probe.ts')

  it('reads the method off each subscribe and ignores everything else', () => {
    expect(
      subscribedMethods(probe, "client.subscribe('terminal.subscribe', params, onData)")
    ).toEqual(['terminal.subscribe'])
    expect(
      subscribedMethods(probe, "entry.client.subscribe('accounts.subscribe', null, cb)")
    ).toEqual(['accounts.subscribe'])
    expect(
      subscribedMethods(probe, "a.subscribe('one', p, cb); b.subscribe('two', p, cb)")
    ).toEqual(['one', 'two'])
    // A store listener, not a host stream: the first argument is not a method.
    expect(subscribedMethods(probe, 'connectionLogStore.subscribe(selectedId, listener)')).toEqual(
      []
    )
    expect(subscribedMethods(probe, 'args.subscribe(handle)')).toEqual([])
    expect(subscribedMethods(probe, "await client.sendRequest('worktree.ps', {})")).toEqual([])
    expect(
      subscribedMethods(probe, '// calls client.subscribe("x", p, cb) under the hood')
    ).toEqual([])
  })

  it('scans a plausible number of files', () => {
    // A broken root or filter would make every check below vacuously pass.
    expect(scanned.length).toBeGreaterThan(400)
    expect(observed.size).toBeGreaterThan(5)
  })

  it('lists each file and method once', () => {
    const seen = RPC_SUBSCRIPTION_SITES.map((site) => `${site.file}\0${site.method}`)
    expect(seen.filter((key, index) => seen.indexOf(key) !== index)).toEqual([])
  })

  it('has no unlisted file opening a stream', () => {
    const unlisted = [...observed.keys()].filter((file) => listedMethods(file).length === 0)
    expect(
      unlisted,
      'A new subscription must be classified in rpc-subscription-inventory.ts: recorded, an unwritten scenario, or walled with the wall named.'
    ).toEqual([])
  })

  it('has no stale inventory entry', () => {
    const stale = RPC_SUBSCRIPTION_SITES.filter((site) => !observed.has(site.file)).map(
      (site) => site.file
    )
    expect(
      stale,
      'File no longer opens a stream — delete its line from rpc-subscription-inventory.ts.'
    ).toEqual([])
  })

  it('classifies every method each listed file opens', () => {
    const mismatched = [...observed]
      .filter(([file]) => listedMethods(file).length > 0)
      .flatMap(([file, methods]) => {
        const listed = [...listedMethods(file)].sort()
        const found = [...new Set(methods)].sort()
        return JSON.stringify(listed) === JSON.stringify(found)
          ? []
          : [`${file}: listed ${listed.join(', ')}, found ${found.join(', ')}`]
      })
    expect(mismatched, 'The method an entry names is what the file opens.').toEqual([])
  })

  it('resolves every recorded family against the scenario manifest', () => {
    const missing = RPC_SUBSCRIPTION_SITES.flatMap((site: RpcSubscriptionSite) =>
      site.coverage.kind === 'recorded' && !families.has(site.coverage.family)
        ? [`${site.file}: no family ${site.coverage.family}`]
        : []
    )
    expect(
      missing,
      'A recorded entry must name a family in pilot-scenarios.json, or the claim is prose.'
    ).toEqual([])
  })

  it('releases by ready id exactly the streams the transport release table names', () => {
    const declared = [
      ...new Set(
        RPC_SUBSCRIPTION_SITES.filter((site) => site.release === 'ready-id').map(
          (site) => site.method
        )
      )
    ].sort()
    expect(
      declared,
      'A stream whose host id arrives in `ready` is released only through READY_STREAM_RELEASE_METHODS.'
    ).toEqual([...READY_STREAM_RELEASE_METHODS.keys()].sort())
  })

  it('names the wall on every walled entry', () => {
    const unnamed = RPC_SUBSCRIPTION_SITES.flatMap((site) =>
      site.coverage.kind === 'walled' && site.coverage.wall.trim().length < 40 ? [site.file] : []
    )
    expect(unnamed, 'A wall has to say what it is; "not supported" is not a wall.').toEqual([])
  })
})
