import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { structuredAgentSessionHandingOver } from './structured-agent-session-handing-over'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import { agentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { createStructuredAgentSessionLifecycleDelivery } from '../../runtime/structured-agent-session-lifecycle-delivery'
import {
  catalogMutationDeadline as settled,
  CLAUDE_MODEL,
  CODEX_MODEL,
  createCatalogMutationFixture
} from './structured-agent-session-catalog-mutation.test-support'
import {
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend
} from './structured-agent-session-rest-test-rig'

let stateDirectory: string
beforeAll(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-catalog-mutation-'))
})
afterAll(async () => {
  await agentModelCatalogStore.flushPersistence()
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('installed catalog inside ordinary serialized mutations', () => {
  it.each([
    ['model', CLAUDE_MODEL],
    ['permissionMode', 'own']
  ])(
    'settles and persists %s at rest, then accepts the next ordinary pick without a provider',
    async (key, value) => {
      const f = await createCatalogMutationFixture(stateDirectory, 'claude')
      try {
        const params = f.request(key, value)
        expect(
          await settled(f.rig.host.setOption(CALLER, params), `${key} mutation`)
        ).toMatchObject({
          ok: true,
          replayed: false,
          value: { key, value, options: { [key]: value } }
        })
        const saved = await f.persisted()
        expect(
          saved.operations[
            agentSessionOperationKey(CALLER.callerKey, params.envelope.clientOperationId)
          ]?.outcome
        ).toMatchObject({ status: 'succeeded', sessionId: SESSION })
        expect(
          key === 'model'
            ? saved.records[SESSION]?.options?.model
            : saved.records[SESSION]?.permissionMode
        ).toBe(value)
        expect(await settled(f.rig.host.setOption(CALLER, params), 'option replay')).toMatchObject({
          ok: true,
          replayed: true,
          value: { key, value }
        })
        expect(
          await settled(
            f.rig.host.setOption(CALLER, f.request('effort', 'high')),
            'next ordinary pick'
          )
        ).toMatchObject({ ok: true, value: { key: 'effort', value: 'high' } })
        expect((await f.persisted()).records[SESSION]?.options?.effort).toBe('high')
        expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
        expect(f.rig.adapter.dispatch).not.toHaveBeenCalled()
        expect(f.rig.adapter.readOptions).not.toHaveBeenCalled()
        expect(f.probe).not.toHaveBeenCalled()
      } finally {
        await f.dispose()
      }
    },
    10_000
  )
})

describe('installed catalog through Codex delivery and report settlement', () => {
  // Real host setup, repeated 2s boundary deadlines and bounded resource drains share this budget.
  it('finishes admitted ran-options bookkeeping, parks, and releases a later ordinary action', async () => {
    const f = await createCatalogMutationFixture(stateDirectory, 'codex')
    try {
      f.rig.host.deps.adapter.open = async () => ({
        reportedOptions: { model: CODEX_MODEL, effort: 'high' }
      })
      const dispatched = Promise.withResolvers<void>()
      f.rig.adapter.dispatch.mockImplementation(async () => {
        expect(f.rig.store.requireWritableRecord(SESSION).options).toBeUndefined()
        dispatched.resolve()
        return { state: 'admitted', ranOptions: { model: CODEX_MODEL, effort: 'high' } }
      })
      const sent = await settled(
        f.rig.host.send(
          CALLER,
          restTestSend(
            'run with the configured model',
            f.rig.store.requireWritableRecord(SESSION).lease.runtimeFence
          )
        ),
        'send acceptance'
      )
      expect(sent).toMatchObject({ ok: true })
      const { conversationDelivery, sessions } = f.rig.host.collaboratorsForTests()
      await settled(dispatched.promise, 'actual Codex dispatch admission')
      expect(f.rig.adapter.dispatch).toHaveBeenCalledOnce()
      expect(f.rig.adapter.acquire).toHaveBeenCalledOnce()
      expect(await f.rig.adapter.acquire.mock.results[0]?.value).not.toHaveProperty('accountHome')
      expect(f.rig.host.childAccountHome(SESSION)).toBeUndefined()
      await settled(conversationDelivery.loop.wake(SESSION), 'admitted delivery settlement')
      expect(sessions.get(SESSION)?.journal.submissions().at(-1)).toMatchObject({
        dispatchState: 'pending',
        handoverRecorded: true
      })
      expect(conversationDelivery.loop.isRunning(SESSION)).toBe(false)
      expect(structuredAgentSessionHandingOver(sessions.get(SESSION)!.journal).size).toBe(0)
      expect((await f.persisted()).records[SESSION]?.options).toEqual({
        model: CODEX_MODEL,
        effort: 'high'
      })
      expect(
        await settled(
          f.rig.host.setOption(CALLER, f.request('permissionMode', 'own')),
          'later ordinary action'
        )
      ).toMatchObject({ ok: true, value: { key: 'permissionMode', value: 'own' } })
      expect(f.rig.store.requireWritableRecord(SESSION).accountHome).toEqual(f.home)
      expect(f.rig.adapter.acquire).toHaveBeenCalledOnce()
      expect(f.probe).not.toHaveBeenCalled()
    } finally {
      await f.dispose()
    }
  }, 10_000)

  // Real host setup, delayed report settlement and bounded resource drains share this budget.
  it('fulfills owed model evidence from a matching delayed lifecycle report outside the delivery lock', async () => {
    const f = await createCatalogMutationFixture(stateDirectory, 'codex')
    try {
      f.rig.host.deps.adapter.open = async () => ({
        reportedOptions: { model: '', effort: 'high' }
      })
      f.rig.adapter.dispatch.mockResolvedValue({
        state: 'admitted',
        ranOptions: { effort: 'high' }
      })
      expect(
        await settled(
          f.rig.host.send(
            CALLER,
            restTestSend(
              'model arrives after admission',
              f.rig.store.requireWritableRecord(SESSION).lease.runtimeFence
            )
          ),
          'model-less send acceptance'
        )
      ).toMatchObject({ ok: true })
      const { conversationDelivery, sessions } = f.rig.host.collaboratorsForTests()
      await settled(conversationDelivery.loop.wake(SESSION), 'model-less admitted delivery')
      const child = sessions.get(SESSION)?.child
      if (!child?.generation) {
        throw new Error('production startup did not publish a child generation')
      }
      expect(child.phase).toBe('ready')
      expect(child.accountHome).toBeUndefined()
      expect(f.rig.store.requireWritableRecord(SESSION).options).toBeUndefined()
      const lifecycle = createStructuredAgentSessionLifecycleDelivery({
        handle: f.rig.host.handleAdapterEvent,
        logger: f.rig.host.deps.logger,
        drainObservedExits: async () => {}
      })
      lifecycle.deliver({
        type: 'options-reported',
        sessionId: SESSION,
        fence: child.fence,
        acquisitionGeneration: child.generation,
        reportedOptions: { model: CODEX_MODEL, effort: 'low' }
      })
      await settled(lifecycle.drain(), 'delayed lifecycle report')
      expect((await f.persisted()).records[SESSION]?.options).toEqual({
        model: CODEX_MODEL,
        effort: 'high'
      })
      await settled(conversationDelivery.loop.wake(SESSION), 'post-report delivery park')
      expect(conversationDelivery.loop.isRunning(SESSION)).toBe(false)
      expect(f.rig.adapter.dispatch).toHaveBeenCalledOnce()
      expect(
        await settled(
          f.rig.host.history({ sessionId: SESSION, direction: 'tail' }),
          'post-report ordinary history'
        )
      ).toMatchObject({ ok: true })
      expect(f.rig.store.requireWritableRecord(SESSION).accountHome).toEqual(f.home)
      expect(f.probe).not.toHaveBeenCalled()
    } finally {
      await f.dispose()
    }
  }, 10_000)
})
