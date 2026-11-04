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

describe('cutover', () => {
  it('retires the whole scope when the logical authority epoch advances', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const beforeCutover = scopeAt('w1', 1)
    const afterCutover = scopeAt('w1', 2)
    const first = pending()
    const loaded = owner.load(beforeCutover, QUERY, first.start)

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

describe('stale-inflight-cleanup', () => {
  it('keeps the first visit to A from landing under the second visit to A', async () => {
    const owner: Owner = new GenerationScopedRequestOwner()
    const a = scopeAt('A', 1)
    const b = scopeAt('B', 1)
    const firstVisit = pending()
    const loaded = owner.load(a, QUERY, firstVisit.start)

    expect(owner.read(b, QUERY)).toBeUndefined()
    expect(owner.read(a, QUERY)).toBeUndefined()

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

    // Only promise identity stops a retired request’s cleanup evicting the new request using its key.
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
    // Put the currency probe between sibling legs so retired attempts never send the second request.
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
