import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  GenerationScopedRequestOwner,
  type LoadedRequest,
  type RequestCurrency,
  type RequestScope
} from './generation-scoped-request-owner'

type Parameters = { readonly query: string }
type Owner = GenerationScopedRequestOwner<Parameters, string[]>

const QUERY: Parameters = { query: 'a' }
const OTHER_QUERY: Parameters = { query: 'b' }

/**
 * One request whose settlement the schedule controls. Every interleaving below is written as an
 * explicit resolution order rather than a timer, so the test states the schedule instead of racing.
 */
function pending(): { start: () => Promise<string[] | null>; resolve: (paths: string[]) => void } {
  let settle: (paths: string[] | null) => void = () => {}
  const promise = new Promise<string[] | null>((resolvePromise) => {
    settle = resolvePromise
  })
  return { start: () => promise, resolve: (paths) => settle(paths) }
}

async function settled<Value>(
  loaded: Promise<LoadedRequest<Value> | null>
): Promise<LoadedRequest<Value>> {
  const result = await loaded
  if (!result) {
    throw new Error('The schedule expected this request to produce a value')
  }
  return result
}

const client = { name: 'physical-client' }

function scopeAt(workspace: string, authority: number, session?: number): RequestScope {
  return session === undefined
    ? [client, workspace, authority]
    : [client, workspace, authority, session]
}

describe('key-reset-cleanup', () => {
  it('drops the cache and the in-flight identity together', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    const first = pending()
    const loaded = owner.load(scope, QUERY, first.start)
    first.resolve(['a.ts'])
    const lease = await settled(loaded)
    expect(owner.commit(lease.lease, lease.value)).toBe('committed')
    expect(owner.read(scope, QUERY)).toEqual(['a.ts'])

    // Still pending when the reset lands: this is the in-flight entry the next load must not join.
    let started = 0
    const crossing = pending()
    const crossingLoaded = owner.load(scope, OTHER_QUERY, () => {
      started++
      return crossing.start()
    })

    owner.reset()
    expect(owner.read(scope, QUERY)).toBeUndefined()

    const second = pending()
    const reloaded = owner.load(scope, OTHER_QUERY, () => {
      started++
      return second.start()
    })
    expect(started).toBe(2)

    crossing.resolve(['crossed.ts'])
    const crossed = await settled(crossingLoaded)
    expect(owner.commit(crossed.lease, crossed.value)).toBe('retired-generation')

    second.resolve(['b.ts'])
    const reloadedLease = await settled(reloaded)
    expect(owner.commit(reloadedLease.lease, reloadedLease.value)).toBe('committed')
    expect(owner.read(scope, OTHER_QUERY)).toEqual(['b.ts'])
  })
})

describe('blur', () => {
  it('refuses a reply that settles after a blur, without the scope having moved', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    const request = pending()
    const loaded = owner.load(scope, QUERY, request.start)

    // The blur bumps the generation the way `use-mobile-send-completion-generation` does: the
    // surface went away, nothing about the host or the workspace did.
    owner.reset()

    request.resolve(['stale.ts'])
    const lease = await settled(loaded)
    expect(owner.commit(lease.lease, lease.value)).toBe('retired-generation')
    expect(owner.read(scope, QUERY)).toBeUndefined()
  })
})

describe('cutover', () => {
  it('retires the whole scope when the logical authority epoch advances', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const beforeCutover = scopeAt('w1', 1)
    const afterCutover = scopeAt('w1', 2)
    const first = pending()
    const loaded = owner.load(beforeCutover, QUERY, first.start)

    // `migrateTo` advanced the logical authority epoch; the next read carries the new one.
    expect(owner.read(afterCutover, QUERY)).toBeUndefined()

    let started = 0
    const second = pending()
    const reloaded = owner.load(afterCutover, QUERY, () => {
      started++
      return second.start()
    })
    expect(started).toBe(1)

    first.resolve(['retired.ts'])
    const retired = await settled(loaded)
    expect(owner.commit(retired.lease, retired.value)).toBe('retired-generation')

    second.resolve(['live.ts'])
    const live = await settled(reloaded)
    expect(owner.commit(live.lease, live.value)).toBe('committed')
    expect(owner.read(afterCutover, QUERY)).toEqual(['live.ts'])
  })
})

describe('reconnect-mid-request', () => {
  it('lets each owner decide whether a same-host reconnect retires its data', async () => {
    // The inventory reads files on disk, which a new authenticated session does not change, so its
    // scope omits the physical session epoch. A capability latch is the opposite: the reconnected
    // host may be a newer build that now answers the method, so its scope carries it.
    const inventory: Owner = new GenerationScopedRequestOwner()
    const capability: Owner = new GenerationScopedRequestOwner()
    const inventoryBefore = scopeAt('w1', 1)
    const capabilityBefore = scopeAt('w1', 1, 1)
    const capabilityAfter = scopeAt('w1', 1, 2)

    const inventoryRequest = pending()
    const capabilityRequest = pending()
    const inventoryLoaded = inventory.load(inventoryBefore, QUERY, inventoryRequest.start)
    const capabilityLoaded = capability.load(capabilityBefore, QUERY, capabilityRequest.start)

    // The socket reauthenticated mid-request: same client, same logical authority, new session.
    expect(capability.read(capabilityAfter, QUERY)).toBeUndefined()
    expect(inventory.read(inventoryBefore, QUERY)).toBeUndefined()

    inventoryRequest.resolve(['kept.ts'])
    capabilityRequest.resolve(['dropped.ts'])
    const keptLease = await settled(inventoryLoaded)
    const droppedLease = await settled(capabilityLoaded)

    expect(inventory.commit(keptLease.lease, keptLease.value)).toBe('committed')
    expect(inventory.read(inventoryBefore, QUERY)).toEqual(['kept.ts'])
    expect(capability.commit(droppedLease.lease, droppedLease.value)).toBe('retired-generation')
    expect(capability.read(capabilityAfter, QUERY)).toBeUndefined()
  })
})

describe('stale-inflight-cleanup', () => {
  it('keeps the first visit to A from landing under the second visit to A', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const a = scopeAt('A', 1)
    const b = scopeAt('B', 1)
    const firstVisit = pending()
    const loaded = owner.load(a, QUERY, firstVisit.start)

    expect(owner.read(b, QUERY)).toBeUndefined()
    expect(owner.read(a, QUERY)).toBeUndefined()

    // The key A builds is the same string it built before; the generation is what differs.
    let started = 0
    const secondVisit = pending()
    const reloaded = owner.load(a, QUERY, () => {
      started++
      return secondVisit.start()
    })
    expect(started).toBe(1)

    firstVisit.resolve(['old.ts'])
    const stale = await settled(loaded)
    expect(owner.commit(stale.lease, stale.value)).toBe('retired-generation')
    expect(owner.read(a, QUERY)).toBeUndefined()

    secondVisit.resolve(['fresh.ts'])
    const fresh = await settled(reloaded)
    expect(owner.commit(fresh.lease, fresh.value)).toBe('committed')
    expect(owner.read(a, QUERY)).toEqual(['fresh.ts'])
  })
})

describe('stale-settlement-cleanup', () => {
  it('keeps a retired request from clearing the slot the live one holds', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    let started = 0
    const stale = pending()
    const live = pending()
    const staleLoaded = owner.load(scope, QUERY, () => {
      started++
      return stale.start()
    })

    owner.reset()
    const liveLoaded = owner.load(scope, QUERY, () => {
      started++
      return live.start()
    })
    expect(started).toBe(2)

    // The retired request settles last. Its cleanup names the slot by key, which the live request
    // now holds, so only promise identity keeps it from evicting a request still in flight.
    stale.resolve(['stale.ts'])
    const retired = await settled(staleLoaded)
    expect(owner.commit(retired.lease, retired.value)).toBe('retired-generation')

    const joined = owner.load(scope, QUERY, () => {
      started++
      return pending().start()
    })
    expect(started).toBe(2)
    expect(joined).toBe(liveLoaded)

    live.resolve(['live.ts'])
    const lease = await settled(joined)
    expect(owner.commit(lease.lease, lease.value)).toBe('committed')
    expect(owner.read(scope, QUERY)).toEqual(['live.ts'])
  })
})

describe('owner boundaries', () => {
  it('refuses a peer owner lease', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const peer: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    const request = pending()
    const loaded = owner.load(scope, QUERY, request.start)
    request.resolve(['a.ts'])
    const lease = await settled(loaded)

    expect(peer.commit(lease.lease, lease.value)).toBe('foreign-owner')
    expect(peer.read(scope, QUERY)).toBeUndefined()
  })

  it('coalesces concurrent loads of one key onto one request', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    let started = 0
    const request = pending()
    const start = () => {
      started++
      return request.start()
    }
    const first = owner.load(scope, QUERY, start)
    const second = owner.load(scope, QUERY, start)
    request.resolve(['a.ts'])
    expect(started).toBe(1)
    expect(await settled(first)).toBe(await settled(second))
  })

  it('separates two workspaces that ask for the same parameters', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const request = pending()
    const loaded = owner.load(scopeAt('A', 1), QUERY, request.start)
    request.resolve(['a.ts'])
    const lease = await settled(loaded)
    expect(owner.commit(lease.lease, lease.value)).toBe('committed')
    expect(owner.read(scopeAt('B', 1), QUERY)).toBeUndefined()
  })
})

describe('currency probe', () => {
  it('flips under a request still in flight when a reset retires it', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    const request = pending()
    const probes: RequestCurrency[] = []
    const loaded = owner.load(scope, QUERY, (currency) => {
      probes.push(currency)
      return request.start()
    })
    expect(probes[0]?.isCurrent()).toBe(true)

    owner.reset()
    expect(probes[0]?.isCurrent()).toBe(false)

    // The probe answers the question `commit` asks, so a loader that ignored it lands here instead.
    request.resolve(['stale.ts'])
    const stale = await settled(loaded)
    expect(owner.commit(stale.lease, stale.value)).toBe('retired-generation')
  })

  it('flips when the next load enters on a scope the owner has not seen', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const request = pending()
    const probes: RequestCurrency[] = []
    const loaded = owner.load(scopeAt('A', 1), QUERY, (currency) => {
      probes.push(currency)
      return request.start()
    })
    expect(probes[0]?.isCurrent()).toBe(true)

    void owner.load(scopeAt('B', 1), QUERY, () => pending().start())
    expect(probes[0]?.isCurrent()).toBe(false)

    request.resolve(['a.ts'])
    const stale = await settled(loaded)
    expect(owner.commit(stale.lease, stale.value)).toBe('retired-generation')
  })

  it('publishes nothing and sends nothing further for a loader that stops on it', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const scope = scopeAt('w1', 1)
    let sent = 0
    const firstLeg = pending()
    const secondLeg = pending()
    // Two legs, as the compare site has: the probe sits between them, so a superseded attempt never
    // reaches the second one.
    const attempt =
      (leg: { start: () => Promise<string[] | null> }) =>
      async (currency: RequestCurrency): Promise<string[] | null> => {
        await leg.start()
        if (!currency.isCurrent()) {
          return null
        }
        sent++
        return ['sent.ts']
      }

    const superseded = owner.load(scope, QUERY, attempt(firstLeg))
    owner.reset()
    const live = owner.load(scope, QUERY, attempt(secondLeg))

    firstLeg.resolve([])
    expect(await superseded).toBeNull()
    expect(sent).toBe(0)
    expect(owner.read(scope, QUERY)).toBeUndefined()

    secondLeg.resolve([])
    const lease = await settled(live)
    expect(sent).toBe(1)
    expect(owner.commit(lease.lease, lease.value)).toBe('committed')
    expect(owner.read(scope, QUERY)).toEqual(['sent.ts'])
  })
})

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
const ownerModule = join(mobileRoot, 'src', 'transport', 'generation-scoped-request-owner')

/** Whether a file imports the owner, resolved rather than pattern-matched on the specifier. */
function importsOwner(path: string, source: string): boolean {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return parsed.statements.some((statement) => {
    const specifier = ts.isImportDeclaration(statement) ? statement.moduleSpecifier : undefined
    return (
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith('.') &&
      resolve(path, '..', specifier.text) === ownerModule
    )
  })
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return [path]
  })
}

function declaredInside(callback: ts.Node): Set<string> {
  const names = new Set<string>()
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        bind(element.name)
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      bind(node.name)
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      names.add(node.name.text)
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      bind(node.variableDeclaration.name)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(callback, visit)
  return names
}

function assignmentRoot(target: ts.Expression): string | null {
  let node: ts.Expression = target
  for (;;) {
    if (ts.isIdentifier(node)) {
      return node.text
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      return 'this'
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      node = node.expression
      continue
    }
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression
      continue
    }
    return null
  }
}

/** Every write a loader body performs to something it did not itself declare. */
function externalWrites(callback: ts.Node): string[] {
  const declared = declaredInside(callback)
  const offenders: string[] = []
  const record = (target: ts.Expression): void => {
    const root = assignmentRoot(target)
    if (root !== null && !declared.has(root)) {
      offenders.push(root)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment) {
      if (node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        record(node.left)
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      record(node.operand)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(callback, visit)
  return offenders
}

function loaders(path: string, source: string): ts.Node[] {
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'load'
    ) {
      const loader = node.arguments[2]
      if (loader && (ts.isArrowFunction(loader) || ts.isFunctionExpression(loader))) {
        found.push(loader)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return found
}

function loaderWrites(path: string, source: string): string[] {
  return loaders(path, source).flatMap((loader) => externalWrites(loader))
}

describe('loader write fence', () => {
  const holders = ['app', 'src']
    .map((directory) => join(mobileRoot, directory))
    .flatMap(sourceFiles)
    .filter((path) => ['.ts', '.tsx'].includes(extname(path)))
    .filter((path) => !/\.test\.tsx?$/.test(path))
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ path, source }) => importsOwner(path, source))

  it('recognizes a loader that writes outside itself and leaves an honest one alone', () => {
    const probe = join(mobileRoot, 'src', 'transport', 'probe.ts')
    expect(
      loaderWrites(probe, 'owner.load(scope, {}, async () => { cacheRef.current = await read() })')
    ).toEqual(['cacheRef'])
    expect(loaderWrites(probe, 'owner.load(scope, {}, async () => { sequence++ })')).toEqual([
      'sequence'
    ])
    expect(
      loaderWrites(probe, 'owner.load(scope, {}, async () => { this.paths = await read() })')
    ).toEqual(['this'])
    expect(
      loaderWrites(
        probe,
        'owner.load(scope, {}, async () => { const rows = await read(); return rows })'
      )
    ).toEqual([])
  })

  it('has every owner holder loading without writing external state', () => {
    // Absence proves nothing without presence: an empty offender list would otherwise pass on a day
    // the scan found no holder and no loader to look inside.
    expect(
      holders.map(({ path }) => relative(mobileRoot, path).split(/[/\\]/).join('/'))
    ).toContain('src/session/use-mobile-native-chat-file-search.ts')
    expect(
      holders.reduce((total, { path, source }) => total + loaders(path, source).length, 0)
    ).toBeGreaterThan(0)
    const offenders = holders
      .map(({ path, source }) => ({
        file: relative(mobileRoot, path).split(/[/\\]/).join('/'),
        writes: loaderWrites(path, source)
      }))
      .filter((entry) => entry.writes.length > 0)
      .map((entry) => `${entry.file}: ${[...new Set(entry.writes)].sort().join(', ')}`)
      .sort()
    expect(
      offenders,
      'Return the value from the loader and publish it with commit(lease, value) instead.'
    ).toEqual([])
  })
})
