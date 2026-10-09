import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { expireAgentModelCatalogFailuresForSettings } from './agent-model-catalog-account-expiry'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

// Why a chat cannot start, as the probe found it: the reason rides every catalog answer until a
// later probe answers again, and a chat's own listing never replaces it.

const HOME = '/homes/selected'
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'codex',
  accountHomeVariable: 'CODEX_HOME',
  accountHomePath: HOME,
  wslDistro: null
})
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const

function listing(id: string, origin: AgentModelCatalogSuccess['origin']): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    fastModeTierByModel: new Map(),
    origin
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const signedOut = (): Promise<AgentModelCatalogSuccess> =>
  Promise.reject(new AgentModelCatalogUnavailableError(SIGNED_OUT))

function rig(initialProbe: AgentModelCatalogProbe = signedOut) {
  let now = 1_000
  let answer = initialProbe
  const store = new AgentModelCatalogStore({ now: () => now })
  const probe = vi.fn((home: string) => answer(home))
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: HOME }),
    probes: { codex: probe }
  })
  const chat = { store, fingerprint: FINGERPRINT, accountHomePath: HOME }
  return {
    store,
    probe,
    service,
    chat,
    /** Lets the probe's verdict land. */
    probed: () => store.refresh(FINGERPRINT, 'codex', probe, () => probe(HOME)),
    answerWith: (next: AgentModelCatalogProbe) => (answer = next),
    pastTtl: () => (now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS)
  }
}

function unavailableOf(result: AgentSessionModelCatalogResult) {
  return result.unavailable
}

describe('a reason the probe found', () => {
  it("survives the chat's own listing, success or failure; only a probe success clears it", async () => {
    const { store, chat, probed, answerWith, service } = rig()
    await probed()
    // A signed-out Codex still answers model/list for a live chat.
    await store.refresh(FINGERPRINT, 'codex', chat, async () => listing('gpt-live', 'live-session'))
    expect(unavailableOf(await service.read({ agent: 'codex' }))).toEqual(SIGNED_OUT)
    await store.refresh(FINGERPRINT, 'codex', { ...chat }, () =>
      Promise.reject(new Error('401 Unauthorized'))
    )
    store.recordFailure(FINGERPRINT, 'codex model listing failed')
    expect(unavailableOf(await service.read({ agent: 'codex' }))).toEqual(SIGNED_OUT)

    answerWith(async () => listing('gpt-probe', 'probe'))
    await probed()
    const result = await service.read({ agent: 'codex' })
    expect(result).not.toHaveProperty('unavailable')
    expect(result.origin).toBe('probe')
  })

  it('is replaced by a probe failure that names no reason', async () => {
    const { store, probed, answerWith } = rig()
    await probed()
    answerWith(() => Promise.reject(new Error('codex probe timed out')))
    await probed()
    expect(store.failure(FINGERPRINT)).not.toHaveProperty('unavailable')
  })

  it("stays readable past its TTL, whoever asks whether it's active", async () => {
    const { store, probed, pastTtl } = rig()
    await probed()
    pastTtl()
    // The live-chat background catalog skips on this check.
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
  })

  it('is expired, not dropped, by a change to that agent’s account settings', async () => {
    const { store, probed } = rig()
    await probed()
    expireAgentModelCatalogFailuresForSettings(store, { activeClaudeManagedAccountId: 'other' })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(true)
    expireAgentModelCatalogFailuresForSettings(store, { activeCodexManagedAccountId: 'other' })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
  })
})

describe('a probe that lists models but finds the account signed out', () => {
  it('keeps the list for the picker and the reason beside it', async () => {
    const { store, probed, service } = rig(async () => ({
      ...listing('gpt-gateway', 'probe'),
      unavailable: SIGNED_OUT
    }))
    await probed()
    expect(store.get(FINGERPRINT)?.models.map((model) => model.id)).toEqual(['gpt-gateway'])
    expect(await service.read({ agent: 'codex' })).toMatchObject({
      origin: 'probe',
      models: [{ id: 'gpt-gateway' }],
      unavailable: SIGNED_OUT
    })
  })
})

describe('a chat that starts under the account', () => {
  it('makes a held reason due, so the next read re-probes instead of trusting it', async () => {
    const { store, probe, probed, answerWith, service } = rig()
    await probed()
    service.providerStarted({
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: HOME },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'workspace',
        workspaceKind: 'folder'
      }
    })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    answerWith(async () => listing('gpt-live', 'probe'))
    expect(await service.read({ agent: 'codex', waitForListing: true })).not.toHaveProperty(
      'unavailable'
    )
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('an expired failure that carries no reason', () => {
  it('is dropped, so failures cannot pile up', () => {
    const { store, pastTtl } = rig()
    store.recordFailure(FINGERPRINT, 'listing timed out', 'codex')
    pastTtl()
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)).toBeNull()
    store.recordFailure(FINGERPRINT, 'listing timed out', 'codex')
    expireAgentModelCatalogFailuresForSettings(store, { activeCodexManagedAccountId: 'other' })
    expect(store.failure(FINGERPRINT)).toBeNull()
  })
})

describe('a catalog read that finds a held reason', () => {
  it('serves it from memory inside the TTL, with no new probe', async () => {
    const { probe, probed, service } = rig()
    await probed()
    expect(await service.read({ agent: 'codex', waitForListing: true })).toEqual({
      origin: 'unknown',
      unavailable: SIGNED_OUT
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('past the TTL, serves it at once and starts one probe; a waiting read gets its answer', async () => {
    const { store, probe, probed, pastTtl, answerWith, service } = rig()
    await probed()
    store.recordSuccess(FINGERPRINT, 'codex', listing('gpt-live', 'live-session'))
    pastTtl()
    const signIn = deferred<AgentModelCatalogSuccess>()
    answerWith(() => signIn.promise)

    const plain = await service.read({ agent: 'codex' })
    expect(plain).toMatchObject({ origin: 'live-session', listingInProgress: true })
    expect(plain.unavailable).toEqual(SIGNED_OUT)
    const waited = service.read({ agent: 'codex', waitForListing: true })
    expect(probe).toHaveBeenCalledTimes(2)

    signIn.resolve(listing('gpt-probe', 'probe'))
    const answer = await waited
    expect(answer).not.toHaveProperty('unavailable')
    expect(answer).not.toHaveProperty('listingInProgress')
    expect(answer.origin).toBe('probe')
  })

  it.each([
    ['still signed out', signedOut, SIGNED_OUT],
    ['a probe that timed out', () => Promise.reject(new Error('timed out')), undefined]
  ] as const)('a waiting read past the TTL answers %s', async (_case, next, expected) => {
    const { probed, pastTtl, answerWith, service } = rig()
    await probed()
    pastTtl()
    answerWith(next)
    expect(unavailableOf(await service.read({ agent: 'codex', waitForListing: true }))).toEqual(
      expected
    )
  })

  it('re-probes on the next read after an account change, inside the old TTL', async () => {
    const { store, probe, probed, answerWith, service } = rig()
    await probed()
    answerWith(async () => listing('gpt-new-account', 'probe'))
    expireAgentModelCatalogFailuresForSettings(store, { codexManagedAccounts: [] })
    const answer = await service.read({ agent: 'codex', waitForListing: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(answer).not.toHaveProperty('unavailable')
  })

  it('never holds a read that does not ask to wait, even on a probe that hangs', async () => {
    const { probed, pastTtl, answerWith, service } = rig()
    await probed()
    pastTtl()
    answerWith(() => new Promise<AgentModelCatalogSuccess>(() => {}))
    expect(await service.read({ agent: 'codex' })).toEqual({
      origin: 'unknown',
      listingInProgress: true,
      unavailable: SIGNED_OUT
    })
  })
})
