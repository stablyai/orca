import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  agentsWithChangedLaunchSettings,
  createAgentModelCatalogSettingsExpiry,
  expireAgentModelCatalogFailuresForSettings
} from './agent-model-catalog-account-expiry'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'

const HOME = '/homes/selected'
const ACCOUNT_HOME = { variable: 'GROK_HOME', path: HOME } as const
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'grok',
  accountHomeVariable: 'GROK_HOME',
  accountHomePath: HOME,
  wslDistro: null
})
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const

function listing(id: string, origin: AgentModelCatalogSuccess['origin']): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
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
  const probe = vi.fn((home: AgentSessionAccountHome, options?: { signal?: AbortSignal }) =>
    answer(home, options)
  )
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => ({
      ...agentSessionRecordFixture(),
      provider: 'grok',
      accountHome: ACCOUNT_HOME
    }),
    drivesRecord: () => true,
    resolveAccountHome: async () => ACCOUNT_HOME,
    probes: { grok: probe }
  })
  return {
    store,
    probe,
    service,
    /** Lets the probe's verdict land. */
    probed: async () => {
      await service.prepareSaved({ agent: 'grok' })
      await store.refresh(FINGERPRINT, 'grok', () => probe(ACCOUNT_HOME))
    },
    answerWith: (next: AgentModelCatalogProbe) => (answer = next),
    pastTtl: () => (now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS)
  }
}

function unavailableOf(result: AgentSessionModelCatalogResult) {
  return result.unavailable
}

describe('a reason the probe found', () => {
  it('survives a real chat listing and a stale receipt; only a probe success clears it', async () => {
    const { probed, answerWith, service, pastTtl } = rig()
    await probed()
    // Signed-out Grok can still return a live model listing.
    const sessionId = agentSessionRecordFixture().sessionId
    service.recordLiveListing(sessionId, { models: listing('gpt-live', 'live-session').models })
    expect(await service.read({ agent: 'grok' })).toMatchObject({
      origin: 'live-session',
      models: [{ id: 'gpt-live' }]
    })
    expect(unavailableOf(await service.read({ agent: 'grok' }))).toEqual(SIGNED_OUT)
    service.recordLiveListing(
      sessionId,
      { models: listing('stale', 'live-session').models },
      () => false
    )
    expect(await service.read({ agent: 'grok' })).toMatchObject({
      origin: 'live-session',
      models: [{ id: 'gpt-live' }]
    })
    expect(unavailableOf(await service.read({ agent: 'grok' }))).toEqual(SIGNED_OUT)

    answerWith(async () => listing('gpt-probe', 'probe'))
    // The later probe must be newer than the live receipt on the fixture clock.
    pastTtl()
    await probed()
    const result = await service.read({ agent: 'grok' })
    expect(result).not.toHaveProperty('unavailable')
    expect(result.origin).toBe('probe')
  })

  it('is replaced by a probe failure that names no reason', async () => {
    const { store, probed, answerWith } = rig()
    await probed()
    answerWith(() => Promise.reject(new Error('grok probe timed out')))
    await probed()
    expect(store.failure(FINGERPRINT)).not.toHaveProperty('unavailable')
  })

  it("stays readable past its TTL, whoever asks whether it's active", async () => {
    const { store, probed, pastTtl } = rig()
    await probed()
    pastTtl()
    // Expired unavailability no longer blocks ordinary chat listing but remains reportable.
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
  })

  it('is expired, not dropped, by a change to that agent’s account settings', async () => {
    const store = new AgentModelCatalogStore()
    await store.refresh(FINGERPRINT, 'codex', signedOut)
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
    expect(await service.read({ agent: 'grok' })).toMatchObject({
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
      ...agentSessionRecordFixture(),
      provider: 'grok',
      accountHome: { variable: 'GROK_HOME', path: HOME },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'workspace',
        workspaceKind: 'folder'
      }
    })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    answerWith(async () => listing('gpt-live', 'probe'))
    expect(await service.read({ agent: 'grok', waitForListing: true })).not.toHaveProperty(
      'unavailable'
    )
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
  })
})

describe('an expired failure that carries no reason', () => {
  it('is dropped, so failures cannot pile up', async () => {
    const { store, pastTtl } = rig()
    await store.refresh(FINGERPRINT, 'grok', () => Promise.reject(new Error('listing timed out')))
    pastTtl()
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)).toBeNull()
    await store.refresh(FINGERPRINT, 'codex', () => Promise.reject(new Error('listing timed out')))
    expireAgentModelCatalogFailuresForSettings(store, { activeCodexManagedAccountId: 'other' })
    expect(store.failure(FINGERPRINT)).toBeNull()
  })
})

describe('a catalog read that finds a held reason', () => {
  it('serves it from memory inside the TTL, with no new probe', async () => {
    const { probe, probed, service } = rig()
    await probed()
    expect(await service.read({ agent: 'grok', waitForListing: true })).toEqual({
      origin: 'unknown',
      unavailable: SIGNED_OUT
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('past the TTL, serves it at once and starts one probe; a waiting read gets its answer', async () => {
    const { store, probe, probed, pastTtl, answerWith, service } = rig()
    await probed()
    store.recordSuccess(FINGERPRINT, 'grok', listing('gpt-live', 'live-session'), 'live')
    pastTtl()
    const signIn = deferred<AgentModelCatalogSuccess>()
    answerWith(() => signIn.promise)

    const plain = await service.read({ agent: 'grok' })
    expect(plain).toMatchObject({ origin: 'live-session' })
    expect(plain.unavailable).toEqual(SIGNED_OUT)
    const waited = service.read({ agent: 'grok', waitForListing: true })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))

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
    expect(unavailableOf(await service.read({ agent: 'grok', waitForListing: true }))).toEqual(
      expected
    )
  })

  it('re-probes on the next read after a command change, inside the old TTL', async () => {
    const { store, probe, probed, answerWith, service } = rig()
    await probed()
    answerWith(async () => listing('gpt-new-account', 'probe'))
    createAgentModelCatalogSettingsExpiry(store, {})(
      { agentCmdOverrides: { grok: '/new/grok' } },
      { agentCmdOverrides: { grok: '/new/grok' } }
    )
    const answer = await service.read({ agent: 'grok', waitForListing: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(answer).not.toHaveProperty('unavailable')
  })

  it('never holds a read that does not ask to wait, even on a probe that hangs', async () => {
    const { probe, probed, pastTtl, answerWith, service } = rig()
    await probed()
    pastTtl()
    const hung = deferred<AgentModelCatalogSuccess>()
    answerWith(() => hung.promise)
    expect(await service.read({ agent: 'grok' })).toEqual({
      origin: 'unknown',
      unavailable: SIGNED_OUT
    })
    expect(probe).toHaveBeenCalledTimes(1)
    const demand = service.demand({ agent: 'grok' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect(await service.read({ agent: 'grok' })).toEqual({
      origin: 'unknown',
      listingInProgress: true,
      unavailable: SIGNED_OUT
    })
    hung.resolve(listing('gpt-probe', 'probe'))
    await demand
  })
})

describe('a probe the host stops', () => {
  it('leaves a held reason as it was', async () => {
    const { store, probe, service, probed, answerWith, pastTtl } = rig()
    await probed()
    pastTtl()
    answerWith(
      (_home, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('session stopped')))
        )
    )
    const demand = service.demand({ agent: 'grok' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect(store.isListing(FINGERPRINT)).toBe(true)
    const signal = probe.mock.calls[1]?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    service.stop()
    await demand
    expect(signal?.aborted).toBe(true)
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
  })
})

describe('a prewarm probe', () => {
  it('sets and clears the reason as a read’s probe does, re-checking it however fresh the catalog', async () => {
    const { store, probe, service, answerWith, pastTtl } = rig(async () => ({
      ...listing('gpt-gateway', 'probe'),
      unavailable: SIGNED_OUT
    }))
    store.recordSuccess(FINGERPRINT, 'grok', listing('gpt-live', 'live-session'), 'live')
    await service.prewarm()
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
    answerWith(async () => listing('gpt-probe', 'probe'))
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(1)
    pastTtl()
    expect(store.isStale(store.get(FINGERPRINT)!)).toBe(false)
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(store.failure(FINGERPRINT)).toBeNull()
  })
})

describe("an agent's command or environment change", () => {
  it('re-lists its fresh catalog and re-checks a held "not installed" at the next prewarm', async () => {
    const { store, probe, service, probed, answerWith } = rig(() =>
      Promise.reject(new AgentModelCatalogUnavailableError({ reason: 'cliMissing' }))
    )
    store.recordSuccess(FINGERPRINT, 'grok', listing('gpt-saved', 'probe'), 'discovery')
    await probed()
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual({ reason: 'cliMissing' })
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(1)
    const expire = createAgentModelCatalogSettingsExpiry(store, { agentCmdOverrides: {} })
    const fixed = { agentCmdOverrides: { grok: '/opt/grok/bin/grok' } }
    expire(fixed, fixed)
    answerWith(async () => listing('gpt-new', 'probe'))
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(store.failure(FINGERPRINT)).toBeNull()
    expect(store.get(FINGERPRINT)!.models.map((model) => model.id)).toEqual(['gpt-new'])
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('touches only the agents whose command or env changed', () => {
    expect(
      agentsWithChangedLaunchSettings(
        {
          agentCmdOverrides: { grok: 'grok', claude: 'claude' },
          agentDefaultEnv: { claude: { A: '1', B: '2' } }
        },
        {
          agentCmdOverrides: { grok: 'grok', claude: 'claude' },
          agentDefaultEnv: { claude: { B: '2', A: '1' }, pi: { KEY: 'x' } }
        }
      )
    ).toEqual(['pi'])
    expect(agentsWithChangedLaunchSettings({ agentCmdOverrides: { grok: 'grok' } }, {})).toEqual([
      'grok'
    ])
  })
})
