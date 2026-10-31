import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { applyCodexConfiguredLaunchDefaults } from '../../codex/codex-configured-launch-defaults'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import { cloneStructuredAgentSessionOptionRecord } from '../../../shared/structured-agent-session-option-state'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'
import { structuredAgentSessionShownSnapshot } from '../../../shared/structured-agent-session-option-view'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import * as catalogBindings from './agent-model-catalog-snapshot'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_MAX_ENTRIES,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const HOME = { variable: 'CODEX_HOME', path: '/account' }
const FOLDERS: Record<string, string> = { a: '/project-a', b: '/project-b', r: '/restricted' }

const listing = (ids: string[], model?: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: ids.map((id) => ({ id, label: id, isDefault: id === ids[0], efforts: [] })),
  configured: model ? { model } : {}
})

function record(sessionId: string, agent: 'claude' | 'codex' = 'codex'): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider: agent,
    accountHome: HOME,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: sessionId,
      workspaceKind: 'folder'
    }
  })
}

function harness(
  agent: 'claude' | 'codex' = 'codex',
  overrides: Partial<AgentModelCatalogServiceDeps> = {}
) {
  const full = ['gpt-a', 'gpt-b', 'gpt-c']
  const byFolder: Record<string, AgentModelCatalogSuccess> = {
    [homedir()]: listing(full),
    '/project-a': listing(full, 'gpt-b'),
    '/project-b': listing(full, 'gpt-c'),
    '/restricted': listing(['local-only'], 'local-only')
  }
  const gates = new Map<string, PromiseWithResolvers<void>>()
  const runs: string[] = []
  const scopeGate = Promise.withResolvers<void>()
  let holdScope = false
  const resolveScope: NonNullable<AgentModelCatalogProbe['resolve']> = async (_home, cwd) => {
    if (holdScope) {
      await scopeGate.promise
    }
    return {
      identity: { command: agent, cwd },
      run: async () => {
        runs.push(cwd)
        await gates.get(cwd)?.promise
        return byFolder[cwd]
      }
    }
  }
  const resolve = vi.fn(resolveScope)
  const probe: AgentModelCatalogProbe = Object.assign(async () => byFolder[homedir()], { resolve })
  const store = overrides.store ?? new AgentModelCatalogStore({ now: () => 1000 })
  const resolveAccountHome = vi.fn<AgentModelCatalogServiceDeps['resolveAccountHome']>(
    async () => HOME
  )
  const probes = { [agent]: probe }
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => agentSessionConversationView(record(id, agent)),
    getRecord: (id) => record(id, agent),
    drivesRecord: () => true,
    resolveAccountHome,
    recordWorkspacePath: async (saved) => FOLDERS[saved.sessionId] ?? null,
    workspaceMayOverrideDefaultModel: async () => false,
    probes,
    ...overrides
  })
  const hold = (folder: string): (() => void) => {
    const gate = Promise.withResolvers<void>()
    gates.set(folder, gate)
    return () => gate.resolve()
  }
  const read = (sessionId: string, extra = {}) => service.read({ agent, sessionId, ...extra })
  onTestFinished(() => service.stop())
  return {
    service,
    probes,
    store,
    runs,
    hold,
    read,
    full,
    byFolder,
    canonicalFingerprint: agentModelCatalogScopeFingerprint(
      agentModelCatalogFingerprint({ agent, accountHome: HOME, wslDistro: null }),
      homedir(),
      { command: agent, cwd: homedir() }
    ),
    resolve,
    resolveScope,
    resolveAccountHome,
    activity: () => [resolveAccountHome.mock.calls.length, resolve.mock.calls.length, runs.length],
    holdScope: () => {
      holdScope = true
      return () => scopeGate.resolve()
    }
  }
}

const ids = (result: Awaited<ReturnType<ReturnType<typeof harness>['read']>>) =>
  result.origin === 'unknown' ? null : result.models.map((model) => model.id)

describe('account model list for folders not yet listed', () => {
  it('shows the account list at once in a new folder, then the folder’s own listing', async () => {
    const h = harness()
    await h.service.read({ agent: 'codex', waitForListing: true })
    await vi.waitFor(() => expect(h.runs).toEqual([homedir()]))
    const release = h.hold('/project-a')
    void h.service.demand({ agent: 'codex', sessionId: 'a' })
    const first = await h.read('a')
    expect(ids(first)).toEqual(h.full)
    // The account list stands in for the folder's; it names no default as the folder's own.
    expect(first).toMatchObject({ listingInProgress: true })
    expect(first.origin !== 'unknown' && first.models.some((model) => model.isDefault)).toBe(false)
    release()
    const settled = await h.read('a', { waitForListing: true })
    expect(ids(settled)).toEqual(h.full)
    expect(settled).not.toHaveProperty('listingInProgress')
    expect(settled.origin !== 'unknown' && settled.models.find((m) => m.isDefault)?.id).toBe(
      'gpt-b'
    )
    h.service.stop()
  })

  it('never seeds other folders from a folder’s own listing', async () => {
    const h = harness()
    await h.read('r', { waitForListing: true })
    expect(h.runs).toEqual(['/restricted'])
    const release = h.hold('/project-b')
    void h.service.demand({ agent: 'codex', sessionId: 'b' })
    expect(ids(await h.read('b'))).toBeNull()
    await h.service.read({ agent: 'codex', waitForListing: true })
    await vi.waitFor(async () => expect(ids(await h.read('b'))).toEqual(h.full))
    release()
    h.service.stop()
  })
})

for (const agent of ['claude', 'codex'] as const) {
  describe(`${agent} account publication and read ownership`, () => {
    it.each(['cache', 'join'] as const)(
      'publishes only on canonical %s reuse of explicit home discovery',
      async (order) => {
        const h = harness(agent)
        const release = h.hold(homedir())
        const explicit = h.service.demand({ agent, workspacePath: homedir() })
        await vi.waitFor(() => expect(h.runs).toEqual([homedir()]))
        if (order === 'cache') {
          release()
          await explicit
        }
        expect(ids(await h.read('a'))).toBeNull()
        const canonical = h.service.demand({ agent })
        if (order === 'join') {
          await vi.waitFor(() => expect(h.resolve.mock.calls.length).toBeGreaterThanOrEqual(3))
          release()
        }
        await Promise.all([explicit, canonical])
        expect(ids(await h.read('a'))).toEqual(h.full)
        expect(ids(await h.service.read({ agent, workspacePath: '/new-folder' }))).toEqual(h.full)
        expect(h.runs).toEqual([homedir()])
      }
    )

    it('never waits for an unresolved account on passive reads, including after the original deadline', async () => {
      vi.useFakeTimers({ now: 1000 })
      onTestFinished(() => {
        vi.useRealTimers()
      })
      const home = Promise.withResolvers<AgentSessionAccountHome>()
      const homeRequested = Promise.withResolvers<void>()
      const resolveAccountHome = vi.fn(() => {
        homeRequested.resolve()
        return home.promise
      })
      const h = harness(agent, { resolveAccountHome })
      const deadline = Date.now() + 50
      const demand = h.service.demand({ agent, workspacePath: '/cold', deadline })
      await homeRequested.promise
      expect(await h.service.read({ agent, workspacePath: '/cold' })).toMatchObject({
        origin: 'unknown'
      })
      expect(resolveAccountHome).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(50)
      await demand
      expect(
        await h.service.read({ agent, workspacePath: '/cold', waitForListing: true, deadline })
      ).toMatchObject({ origin: 'unknown' })
      expect(resolveAccountHome).toHaveBeenCalledTimes(1)
      home.resolve(HOME)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.resolve).not.toHaveBeenCalled()
      expect(h.runs).toEqual([])
    })

    it.each(['null', 'rejected', 'deadline'] as const)(
      'retains accepted canonical defaults through %s scope refresh and a later successful owner',
      async (outcome) => {
        vi.useFakeTimers({ now: 1000 })
        onTestFinished(() => {
          vi.useRealTimers()
        })
        const h = harness(agent, {
          getConversation: () => undefined,
          getRecord: () => undefined,
          listingNamesConfiguredModel: new Set([agent])
        })
        const save = vi.fn()
        await h.store.attachPersistence({ load: async () => [], save, flush: async () => {} })
        h.byFolder[homedir()] = listing(h.full, h.full[1])
        await h.service.demand({ agent })
        const accepted = await h.service.read({ agent })
        const seed = getAgentSessionOptionCatalog(agent)
        if (!seed) {
          throw new Error(`missing option catalog for ${agent}`)
        }
        const check = async () => {
          const calls = h.activity()
          const missingRecord = await h.service.read({ agent, sessionId: 'not-created-yet' })
          const answers = [
            h.service.snapshot({ agent }),
            h.service.snapshot({ agent, savedOnly: true }),
            h.service.snapshot({ agent, verifiedOnly: true }),
            await h.service.read({ agent }),
            await h.service.read({ agent, savedOnly: true }),
            missingRecord
          ]
          for (const answer of answers) {
            expect(answer).toEqual(accepted)
          }
          const state = applyStructuredAgentSessionModelCatalog(
            createStructuredAgentSessionOptionState(agent, seed),
            seed,
            missingRecord,
            { newLaunch: true, coherentCatalog: true }
          )
          expect(
            structuredAgentSessionShownSnapshot(state).find((row) => row.id === 'model')
          ).toMatchObject({ kind: { currentValue: h.full[1] }, valueSource: 'default' })
          expect(h.activity()).toEqual(calls)
          expect(h.runs).toEqual([homedir()])
          expect(save).not.toHaveBeenCalled()
        }
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        if (outcome === 'deadline') {
          h.resolve.mockImplementation(async (...args) => {
            entered.resolve()
            await release.promise
            return h.resolveScope(...args)
          })
        } else if (outcome === 'null') {
          // Failed snapshot and recovery lookups produce a null scope.
          h.resolve.mockRejectedValue(null)
        } else {
          h.resolve.mockImplementation(() => {
            throw new Error('lookup rejected')
          })
        }
        save.mockClear()
        const publish = vi.spyOn(h.store, 'recordSuccess')
        const lookups = h.resolve.mock.calls.length
        const demand = h.service.demand({ agent, deadline: Date.now() + 50 })
        if (outcome === 'deadline') {
          await entered.promise
          await check()
          await vi.advanceTimersByTimeAsync(50)
        }
        await demand
        expect(h.resolve).toHaveBeenCalledTimes(lookups + (outcome === 'null' ? 2 : 1))
        await check()
        expect(publish).not.toHaveBeenCalled()
        // A later legitimate owner progresses before the obsolete resolver is released.
        h.resolve.mockImplementation(async (...args) => ({
          ...(await h.resolveScope(...args)),
          identity: { revision: 2, command: agent, cwd: homedir() }
        }))
        h.byFolder[homedir()] = listing(['next-model'], 'next-model')
        await h.service.demand({ agent })
        const next = await h.service.read({ agent })
        expect(next).toMatchObject({ models: [{ id: 'next-model', isDefault: true }] })
        const writes = [publish.mock.calls.length, save.mock.calls.length, h.runs.length]
        release.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(await h.service.read({ agent })).toEqual(next)
        expect([publish.mock.calls.length, save.mock.calls.length, h.runs.length]).toEqual(writes)
      }
    )

    it.each([
      ['retire', 'account'],
      ['stop', 'account'],
      ['retire', 'scope'],
      ['stop', 'scope']
    ] as const)(
      '%s rejects late %s resolution and preserves valid pinned accounts',
      async (action, phase) => {
        const h = harness(agent)
        await h.service.read({ agent, waitForListing: true })
        expect(ids(await h.service.read({ agent, workspacePath: '/cold' }))).toEqual(h.full)
        const home = Promise.withResolvers<AgentSessionAccountHome>()
        const entered = Promise.withResolvers<void>()
        if (phase === 'account') {
          h.resolveAccountHome.mockImplementationOnce(() => {
            entered.resolve()
            return home.promise
          })
        } else {
          h.resolve.mockImplementationOnce(async (...args) => {
            entered.resolve()
            await home.promise
            return h.resolveScope(...args)
          })
        }
        const late = h.service.demand({ agent })
        await entered.promise
        if (action === 'stop') {
          h.service.stop()
        } else {
          h.store.expireFailures(agent)
          h.service.retireContext()
        }
        home.resolve(HOME)
        await late
        expect(await h.service.read({ agent })).toEqual({ origin: 'unknown' })
        expect(ids(await h.service.read({ agent, workspacePath: '/late' }))).toBeNull()
        expect(ids(await h.read('a'))).toEqual(action === 'stop' ? null : h.full)
        expect(h.runs).toEqual([homedir()])
        h.service.stop()
        expect(await h.read('a')).toEqual({ origin: 'unknown' })
        expect(await h.service.read({ agent, workspacePath: '/late' })).toEqual({
          origin: 'unknown'
        })
      }
    )

    it('uses the newly resolved account base even without a settings invalidation', async () => {
      const h = harness(agent)
      await h.service.demand({ agent })
      const revision = h.store.retirementRevision(agent)
      const otherHome = { variable: HOME.variable, path: '/other-account' }
      h.resolveAccountHome.mockResolvedValue(otherHome)
      h.store.recordSuccess(
        agentModelCatalogFingerprint({ agent, accountHome: otherHome, wslDistro: null }),
        agent,
        listing(['other-account'], 'other-account'),
        'discovery'
      )
      h.resolve.mockRejectedValue(new Error('scope not available'))
      await h.service.demand({ agent })
      const calls = h.activity()
      const publish = vi.spyOn(h.store, 'recordSuccess')
      expect(await h.service.read({ agent })).toMatchObject({
        models: [{ id: 'other-account', isDefault: false }],
        listingNamesConfiguredModel: false
      })
      expect(h.service.snapshot({ agent, verifiedOnly: true })).toEqual({ origin: 'unknown' })
      expect(ids(await h.read('a'))).toEqual(h.full)
      expect(h.store.retirementRevision(agent)).toBe(revision)
      expect(h.activity()).toEqual(calls)
      expect(publish).not.toHaveBeenCalled()
      h.resolve.mockImplementation(h.resolveScope)
      h.byFolder[homedir()] = listing(['other-account'], 'other-account')
      await h.service.demand({ agent })
      expect(await h.service.read({ agent })).toMatchObject({
        models: [{ id: 'other-account', isDefault: true }]
      })
    })

    it('keeps newer saved publication after an older ordinary resolution is retired', async () => {
      const h = harness(agent)
      const publish = vi.spyOn(h.store, 'recordSuccess')
      await h.service.demand({ agent })
      const exact = h.canonicalFingerprint
      expect(h.store.observation(exact)).not.toBeNull()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      h.resolve.mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return h.resolveScope(...args)
      })
      const old = h.service.demand({ agent })
      await entered.promise
      h.store.expireFailures(agent)
      h.service.retireContext()
      h.store.recordSuccess(exact, agent, listing(h.full, h.full[2]), 'discovery')
      const saved = await h.service.prepareSaved({ agent })
      expect(saved).toMatchObject({
        models: [
          { id: h.full[0], isDefault: false },
          { id: h.full[1], isDefault: false },
          { id: h.full[2], isDefault: true }
        ]
      })
      publish.mockClear()
      release.resolve()
      await old
      expect(await h.service.read({ agent })).toEqual(saved)
      expect(publish).not.toHaveBeenCalled()
      expect(h.runs).toEqual([homedir()])
    })

    it.each(['stale', 'missing', 'retired'] as const)(
      'retaining canonical identity cannot certify a %s exact observation',
      async (state) => {
        let now = 1000
        const h = harness(agent, { store: new AgentModelCatalogStore({ now: () => now }) })
        h.byFolder[homedir()] = listing(h.full, h.full[1])
        const publish = vi.spyOn(h.store, 'recordSuccess')
        await h.service.demand({ agent })
        const exact = h.canonicalFingerprint
        expect(h.store.observation(exact)).not.toBeNull()
        h.resolve.mockRejectedValue(new Error('scope not available'))
        await h.service.demand({ agent })
        if (state === 'stale') {
          now += AGENT_MODEL_CATALOG_FRESH_MS + 1
        } else if (state === 'missing') {
          for (let index = 0; index < AGENT_MODEL_CATALOG_MAX_ENTRIES; index++) {
            h.store.recordSuccess(`unrelated-${index}`, 'grok', listing(['other']), 'discovery')
          }
          expect(h.store.get(exact)).toBeNull()
        } else {
          h.store.expireAgent(agent)
          expect(h.store.observation(exact)).toBeNull()
        }
        const calls = h.activity()
        publish.mockClear()
        expect(h.service.snapshot({ agent, verifiedOnly: true })).toEqual({ origin: 'unknown' })
        const answer = await h.service.read({ agent })
        if (answer.origin !== 'unknown') {
          expect(answer.models.every((row) => !row.isDefault)).toBe(true)
          expect(answer.listingNamesConfiguredModel).toBe(false)
        }
        expect(h.activity()).toEqual(calls)
        expect(publish).not.toHaveBeenCalled()
      }
    )

    it('does not publish incomplete or retired canonical discoveries', async () => {
      const h = harness(agent)
      const publish = vi.spyOn(h.store, 'recordSuccess')
      h.byFolder[homedir()] = { ...listing(h.full), complete: false }
      await h.service.read({ agent, waitForListing: true })
      expect(publish).not.toHaveBeenCalled()
      expect(ids(await h.read('a'))).toBeNull()
      h.store.expireAgent(agent)
      h.service.retireContext()
      h.byFolder[homedir()] = listing(h.full)
      const release = h.hold(homedir())
      const late = h.service.demand({ agent })
      await vi.waitFor(() => expect(h.runs).toHaveLength(2))
      h.service.stop()
      release()
      await late
      expect(publish).not.toHaveBeenCalled()
      expect(
        h.store.observation(
          agentModelCatalogFingerprint({ agent, accountHome: HOME, wslDistro: null })
        )
      ).toBeNull()
    })

    it('retains current canonical account proof under N/10N transient binding pressure', async () => {
      for (const count of [260, 2600]) {
        let bindings: Map<string, AgentModelCatalogBinding> | undefined
        let evictionVisits = 0
        const bind = catalogBindings.bindAgentModelCatalogScope
        const bindSpy = vi
          .spyOn(catalogBindings, 'bindAgentModelCatalogScope')
          .mockImplementation((map, ...args) => {
            if (!bindings) {
              bindings = map
              const keys = map.keys.bind(map)
              vi.spyOn(map, 'keys').mockImplementation(() => {
                const iterator = keys()
                const next = iterator.next.bind(iterator)
                iterator.next = (...args) => {
                  const result = next(...args)
                  if (!result.done) {
                    evictionVisits++
                  }
                  return result
                }
                return iterator
              })
            }
            return bind(map, ...args)
          })
        const h = harness(agent)
        try {
          const other = agent === 'claude' ? 'codex' : 'claude'
          h.probes[other] = h.probes[agent]
          const save = vi.fn()
          await h.store.attachPersistence({ load: async () => [], save, flush: async () => {} })
          await h.service.read({ agent, waitForListing: true })
          await h.service.read({ agent: other, waitForListing: true })
          save.mockClear()
          const base = agentModelCatalogFingerprint({ agent, accountHome: HOME, wslDistro: null })
          const publish = vi.spyOn(h.store, 'recordSuccess')
          for (let index = 0; index < count; index++) {
            const workspacePath = `/binding-pressure-${index}`
            h.byFolder[workspacePath] = { ...listing([]), complete: false }
            await h.service.demand({ agent, workspacePath })
          }
          expect(h.store.observation(base)).not.toBeNull()
          const resolutions = h.resolveAccountHome.mock.calls.length
          const scopes = h.resolve.mock.calls.length
          const probes = h.runs.length
          const cold = { agent, workspacePath: '/unseen-after-pressure' }
          expect(ids(await h.service.read(cold))).toEqual(h.full)
          expect(bindings?.size).toBe(258)
          expect(evictionVisits).toBeGreaterThanOrEqual(count - 256)
          expect(evictionVisits).toBeLessThanOrEqual(3 * (count - 256))
          expect(ids(await h.read('a'))).toEqual(h.full)
          expect(ids(await h.service.read({ ...cold, agent: other }))).toEqual(h.full)
          expect(save).not.toHaveBeenCalled()
          expect(h.resolveAccountHome).toHaveBeenCalledTimes(resolutions)
          expect(h.resolve).toHaveBeenCalledTimes(scopes)
          expect(h.runs).toHaveLength(probes)
          expect(publish).not.toHaveBeenCalled()
          h.store.expireFailures(agent)
          h.service.retireContext()
          expect(ids(await h.service.read(cold))).toBeNull()
          expect(bindings?.size).toBe(1)
          expect(ids(await h.service.read({ ...cold, agent: other }))).toEqual(h.full)
          expect(ids(await h.read('a'))).toEqual(h.full)
          await h.service.read({ agent, waitForListing: true })
          expect(ids(await h.service.read(cold))).toEqual(h.full)
          h.service.stop()
          expect(await h.service.read(cold)).toEqual({ origin: 'unknown' })
          expect(await h.read('a')).toEqual({ origin: 'unknown' })
          expect(bindings?.size).toBe(0)
          process.stdout.write(
            `CANONICAL_BINDING_PRESSURE ${JSON.stringify({ agent, requests: count, evictionVisits, retainedBeforeRetirement: 258, probesBeforeCold: probes })}\n`
          )
        } finally {
          h.service.stop()
          bindSpy.mockRestore()
        }
      }
    })

    it('roundtrips the account inventory and serves cold reads while prewarm scope resolution is suspended', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pr-36646-account-reload-'))
      onTestFinished(() => rm(directory, { recursive: true, force: true }))
      const first = harness(agent)
      await first.store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
      await first.service.prewarm()
      // This fixture has no usage until a catalog is requested.
      await first.service.read({ agent, waitForListing: true })
      await first.store.flushPersistence()
      first.service.stop()
      const store = new AgentModelCatalogStore()
      const persistence = createAgentModelCatalogFilePersistence(directory)
      const save = vi.fn(persistence.save)
      await store.attachPersistence({ ...persistence, save })
      const h = harness(agent, { store })
      const release = h.holdScope()
      const prewarm = h.service.prewarm()
      await vi.waitFor(() => expect(h.resolve).toHaveBeenCalled())
      expect(ids(await h.read('a'))).toEqual(h.full)
      expect(ids(await h.service.read({ agent, workspacePath: '/cold' }))).toEqual(h.full)
      expect(await h.service.read({ agent, savedOnly: true })).toMatchObject({
        modelsDifferByWorkspace: true,
        listingNamesConfiguredModel: false
      })
      expect(h.service.snapshot({ agent, verifiedOnly: true })).toEqual({ origin: 'unknown' })
      expect(h.runs).toEqual([])
      expect(save).not.toHaveBeenCalled()
      expect(h.resolveAccountHome).toHaveBeenCalledTimes(1)
      release()
      await prewarm
      expect(h.runs).toEqual([homedir()])
      await store.flushPersistence()
    })

    it('keeps configured effort local through the shared displayed view and preserves an unlisted pick', async () => {
      const h = harness(agent)
      const efforts = ['low', 'medium', 'high'].map((value) => ({ value, label: value }))
      const raw = [
        {
          id: h.full[0],
          label: 'Model',
          isDefault: true,
          efforts,
          defaultEffort: 'medium',
          declaredDefaultEffort: 'medium'
        }
      ]
      const configured = (effort: string): AgentModelCatalogSuccess => ({
        origin: 'probe',
        complete: true,
        configured: { model: h.full[0], effort },
        // Codex folds configured defaults into rows before the catalog service sees them.
        models: applyCodexConfiguredLaunchDefaults(raw, { model: h.full[0], effort })
      })
      h.byFolder[homedir()] = configured('high')
      h.byFolder['/project-a'] = configured('low')
      await h.service.read({ agent, waitForListing: true })
      const release = h.hold('/project-a')
      const demand = h.service.demand({ agent, sessionId: 'a' })
      const fallback = await h.read('a')
      expect(fallback).toMatchObject({
        models: [{ isDefault: false }],
        listingNamesConfiguredModel: false,
        listingInProgress: true
      })
      if (fallback.origin === 'unknown') {
        throw new Error('missing fallback')
      }
      expect(fallback.models[0]).not.toHaveProperty('defaultEffort')
      expect(fallback.models[0]).not.toHaveProperty('declaredDefaultEffort')
      const seed = getAgentSessionOptionCatalog(agent)
      if (!seed) {
        throw new Error(`missing option catalog for ${agent}`)
      }
      const initial = commitStructuredAgentSessionOptionValues(
        createStructuredAgentSessionOptionState(agent, seed),
        { model: h.full[0] },
        'seeded'
      )
      const apply = (state: typeof initial, catalog: AgentSessionModelCatalogResult) =>
        applyStructuredAgentSessionModelCatalog(state, seed, catalog, {
          newLaunch: true,
          coherentCatalog: true
        })
      const provisional = apply(initial, fallback)
      expect(provisional.verifiedModelIds).toBeUndefined()
      expect(
        structuredAgentSessionShownSnapshot(provisional).find((row) => row.id === 'effort')
      ).not.toMatchObject({ kind: { currentValue: 'high' }, valueSource: 'default' })
      const picked = commitStructuredAgentSessionOptionValues(
        { ...provisional, record: cloneStructuredAgentSessionOptionRecord(provisional.record) },
        {
          model: 'retired-custom',
          effort: 'high'
        }
      )
      const pickedFallback = apply(picked, fallback)
      expect(pickedFallback.record.values.model).toEqual({
        value: 'retired-custom',
        source: 'dispatched'
      })
      expect(pickedFallback.record.values.effort).toEqual({ value: 'high', source: 'dispatched' })
      release()
      await demand
      const folder = await h.read('a')
      const authoritative = apply(provisional, folder)
      expect(authoritative.verifiedModelIds).toEqual([h.full[0]])
      expect(
        structuredAgentSessionShownSnapshot(authoritative).find((row) => row.id === 'effort')
      ).toMatchObject({ kind: { currentValue: 'low' }, valueSource: 'default' })
      const after = apply(pickedFallback, folder)
      expect(after.catalog?.models.map((model) => model.id)).toEqual([h.full[0]])
      expect(after.record.values.model).toEqual({ value: 'retired-custom', source: 'dispatched' })
      expect(after.record.values.effort).toEqual({ value: 'high', source: 'dispatched' })
      expect(
        structuredAgentSessionShownSnapshot(after).find((row) => row.id === 'model')
      ).toMatchObject({ kind: { currentValue: 'retired-custom' } })
    })
  })
}

it.each(['claude', 'codex'] as const)(
  '%s account publication work stays scoped at N and 10N with changed-output controls',
  async (agent) => {
    for (const population of [10, 100]) {
      let now = 1000
      const rows = population === 10 ? 61 : 610
      const store = new AgentModelCatalogStore({ now: () => now })
      for (let index = 0; index < population; index++) {
        store.recordSuccess(`unrelated-${index}`, 'grok', listing([`other-${index}`]), 'discovery')
      }
      const directory = await mkdtemp(join(tmpdir(), 'pr-36646-account-perf-'))
      onTestFinished(() => rm(directory, { recursive: true, force: true }))
      const persistence = createAgentModelCatalogFilePersistence(directory)
      let materializations = 0
      const save = vi.fn((snapshot: () => readonly AgentModelCatalogEntry[]) =>
        persistence.save(() => {
          materializations++
          return snapshot()
        })
      )
      await store.attachPersistence({ ...persistence, save })
      const h = harness(agent, { store, hasChatRecords: () => true })
      let inputVisits = 0
      const account = listing(Array.from({ length: rows }, (_, index) => `scale-${index}`))
      account.models = account.models.map((row) => ({
        ...row,
        get id() {
          inputVisits++
          return row.id
        }
      }))
      h.byFolder[homedir()] = account
      const publish = vi.spyOn(store, 'recordSuccess')
      const observed = vi.spyOn(store, 'observation')
      let comparisons = 0
      const find = Array.prototype.find
      const scan = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
        this: unknown[],
        predicate,
        thisArg
      ) {
        return find.call(this, (value, index, array) => {
          if (
            value &&
            typeof value === 'object' &&
            'id' in value &&
            typeof value.id === 'string' &&
            value.id.startsWith('scale-')
          ) {
            comparisons++
          }
          return predicate.call(thisArg, value, index, array)
        })
      })
      onTestFinished(() => scan.mockRestore())
      await h.service.prewarm()
      const initialComparisons = comparisons
      const initialInputVisits = inputVisits
      expect(h.runs).toEqual([homedir()])
      expect(publish).toHaveBeenCalledTimes(1)
      expect(publish.mock.calls[0]?.[0]).toBe(
        agentModelCatalogFingerprint({ agent, accountHome: HOME, wslDistro: null })
      )
      expect(save).toHaveBeenCalledTimes(2)
      expect(materializations).toBe(0)
      await store.flushPersistence()
      expect(materializations).toBe(1)
      // Both existing exact and added base ingestion keep the existing quadratic row merge bound.
      expect(initialComparisons).toBeGreaterThanOrEqual(rows * rows)
      expect(initialComparisons).toBeLessThanOrEqual(4 * rows * rows + 10 * rows)
      expect(initialInputVisits).toBeGreaterThanOrEqual(rows)
      expect(initialInputVisits).toBeLessThanOrEqual(8 * rows)
      publish.mockClear()
      observed.mockClear()
      save.mockClear()
      const resolverCalls = h.resolveAccountHome.mock.calls.length
      const scopeCalls = h.resolve.mock.calls.length
      const readComparisons = comparisons
      for (let index = 0; index < population; index++) {
        const answer = await h.service.read({ agent, workspacePath: `/unbound-${index}` })
        expect(ids(answer)).toEqual(account.models.map((row) => row.id))
      }
      expect(comparisons).toBe(readComparisons)
      expect(h.resolveAccountHome).toHaveBeenCalledTimes(resolverCalls)
      expect(h.resolve).toHaveBeenCalledTimes(scopeCalls)
      expect(h.runs).toEqual([homedir()])
      expect(publish).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(observed.mock.calls.every(([key]) => !key.startsWith('unrelated-'))).toBe(true)
      await h.service.prewarm()
      expect(h.runs).toEqual([homedir()])
      expect(publish).not.toHaveBeenCalled()
      expect(comparisons).toBe(readComparisons)
      expect(save).not.toHaveBeenCalled()
      now += AGENT_MODEL_CATALOG_FRESH_MS + 1
      await h.service.prewarm()
      expect(h.runs).toEqual([homedir(), homedir()])
      expect(save).not.toHaveBeenCalled()
      await store.flushPersistence()
      expect(materializations).toBe(1)
      now += AGENT_MODEL_CATALOG_FRESH_MS + 1
      h.byFolder[homedir()] = listing([
        ...account.models.map((row) => row.id).slice(0, -1),
        'scale-changed'
      ])
      await h.service.prewarm()
      const changed = await h.service.read({ agent, workspacePath: '/changed-control' })
      expect(changed.origin !== 'unknown' && changed.models.at(-1)?.id).toBe('scale-changed')
      expect(save).toHaveBeenCalledTimes(2)
      await store.flushPersistence()
      expect(materializations).toBe(2)
      expect((await persistence.load()).length).toBe(population + 2)
      scan.mockRestore()
      process.stdout.write(
        `ACCOUNT_PUBLICATION ${JSON.stringify({ agent, population, rows, comparisons: initialComparisons, inputVisits: initialInputVisits, coldReaders: population, probes: h.runs.length, materializations })}\n`
      )
    }
  }
)
