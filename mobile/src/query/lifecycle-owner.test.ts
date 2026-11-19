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

// Control explicit completion order instead of racing timers.
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

describe('reconnect-mid-request', () => {
  it('lets each owner decide whether a same-host reconnect retires its data', async () => {
    // Disk inventory survives reauthentication; capability latches may change with a newer host build and include the session epoch.
    const inventory: Owner = new GenerationScopedRequestOwner()
    const capability: Owner = new GenerationScopedRequestOwner()
    const inventoryBefore = scopeAt('w1', 1)
    const capabilityBefore = scopeAt('w1', 1, 1)
    const capabilityAfter = scopeAt('w1', 1, 2)

    const inventoryRequest = pending()
    const capabilityRequest = pending()
    const inventoryLoaded = inventory.load(inventoryBefore, QUERY, inventoryRequest.start)
    const capabilityLoaded = capability.load(capabilityBefore, QUERY, capabilityRequest.start)

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

describe('owner boundaries', () => {
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
})
