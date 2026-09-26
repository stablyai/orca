import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunHomePair } from './run-home-pair.test-support'
import { syncFederatedDispatch } from '../../../../orchestration/federation-sync'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'

describe('two-host Run-home routing through RPC and durable relay', () => {
  let pair: ReturnType<typeof createRunHomePair>
  afterEach(() => pair?.close())

  it.each([1, 2, 3])(
    'preserves capability-bound relay custody with protocol %i',
    async (version) => {
      pair = createRunHomePair(version)
      const { workerDb, homeDb, homeRuntime, run, dispatch } = pair
      expect(workerDb.getRun(run.id)?.home_database).toBe('remote')
      const sent = await pair.send('report')
      expect(sent).toMatchObject({
        ok: true,
        result: {
          relay: {
            state: 'queued',
            destination: 'run_home',
            custody: 'worker_relay',
            homeRunId: run.id,
            accepted: true
          }
        }
      })
      expect(workerDb.getUnreadRunMailbox(run.id)).toHaveLength(0)
      expect(homeDb.getUnreadRunMailbox(run.id)).toHaveLength(0)
      await syncFederatedDispatch(homeRuntime, dispatch.id)
      expect(homeDb.getUnreadRunMailbox(run.id)).toHaveLength(1)
      const checked = await pair.homeDispatcher.dispatch({
        id: 'check',
        authToken: 'home-token',
        method: 'orchestration.check',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'check',
        params: { terminal: 'term_coord', run: run.id }
      })
      expect(checked).toMatchObject({
        ok: true,
        result: { count: 1, messages: [{ subject: 'Progress', to_handle: `run:${run.id}` }] }
      })
    }
  )

  it('rejects an unbound shadow send through RPC with no mailbox or relay effect', async () => {
    pair = createRunHomePair(2)
    const response = await pair.send(
      'unbound',
      { from: 'term_unbound', to: `run:${pair.run.id}` },
      null
    )
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'run_destination_unsupported',
        data: { effectsApplied: false }
      }
    })
    expect(
      await pair.send('unbound', { from: 'term_unbound', to: `run:${pair.run.id}` }, null)
    ).toMatchObject({ ok: false, error: { code: 'run_destination_unsupported' } })
    await syncFederatedDispatch(pair.homeRuntime, pair.dispatch.id)
    expect(pair.homeDb.getUnreadRunMailbox(pair.run.id)).toHaveLength(0)
    expect(pair.workerDb.getInbox(100)).toHaveLength(0)
    expect(pair.workerDb.listPendingFederationRelay(pair.dispatch.id, 'to_home')).toHaveLength(0)
  })

  it('retains consumer fencing on the shadow without takeover', async () => {
    pair = createRunHomePair(2)
    const response = await pair.workerDispatcher.dispatch({
      id: 'shadow-check',
      authToken: 'worker-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'shadow-check',
      params: { terminal: 'term_unbound', run: pair.run.id }
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(pair.workerDb.getRun(pair.run.id)?.consumer_generation).toBe(0)
    expect(pair.homeDb.getRun(pair.run.id)?.consumer_generation).toBe(1)
  })

  it('returns a structured unresolved refusal for a never-bound local Run', async () => {
    pair = createRunHomePair(2)
    pair.workerDb.db
      .prepare(`INSERT INTO runs (id, objective) VALUES ('run_orphan', 'orphan')`)
      .run()
    expect(await pair.send('orphan', { from: 'term_unbound', to: 'run:run_orphan' })).toMatchObject(
      { ok: false, error: { code: 'run_destination_unresolved', data: { effectsApplied: false } } }
    )
    expect(pair.workerDb.getInbox(100)).toHaveLength(0)
  })

  it('keeps unavailable-host mail in relay custody and imports it only once after recovery', async () => {
    pair = createRunHomePair(2)
    pair.contact.available = false
    const first = await pair.send('retry-stable-id')
    await expect(syncFederatedDispatch(pair.homeRuntime, pair.dispatch.id)).rejects.toThrow(
      'host unavailable'
    )
    expect(pair.homeDb.getUnreadRunMailbox(pair.run.id)).toHaveLength(0)
    expect(pair.workerDb.getUnreadRunMailbox(pair.run.id)).toHaveLength(0)
    const repeated = await pair.send('retry-stable-id')
    expect(repeated).toMatchObject({
      ok: true,
      result: expect.objectContaining({ relay: expect.any(Object) })
    })
    if (!first.ok || !repeated.ok) {
      throw new Error('Expected queued receipts')
    }
    expect(repeated).toMatchObject({ result: { mutation: { replayed: true } } })
    expect(pair.workerDb.listPendingFederationRelay(pair.dispatch.id, 'to_home')).toHaveLength(1)
    pair.contact.available = true
    await syncFederatedDispatch(pair.homeRuntime, pair.dispatch.id)
    await syncFederatedDispatch(pair.homeRuntime, pair.dispatch.id)
    expect(pair.homeDb.getUnreadRunMailbox(pair.run.id)).toHaveLength(1)
  })

  it('rejects stale capability authority before either mailbox changes', async () => {
    pair = createRunHomePair(2)
    vi.mocked(pair.workerRuntime.getTerminalProcessIncarnation).mockReturnValue('worker:pty:2')
    expect(await pair.send('stale')).toMatchObject({
      ok: false,
      error: { code: 'dispatch_capability_invalid' }
    })
    expect(pair.workerDb.listPendingFederationRelay(pair.dispatch.id, 'to_home')).toHaveLength(0)
    expect(pair.workerDb.getInbox(100)).toHaveLength(0)
  })

  it('does not redirect custody when the saved peer changes', async () => {
    pair = createRunHomePair(2)
    await pair.send('peer-change')
    pair.contact.peerFingerprint = 'replacement-peer'
    await expect(syncFederatedDispatch(pair.homeRuntime, pair.dispatch.id)).rejects.toMatchObject({
      code: 'peer_changed'
    })
    expect(pair.homeDb.getUnreadRunMailbox(pair.run.id)).toHaveLength(0)
    expect(pair.workerDb.listPendingFederationRelay(pair.dispatch.id, 'to_home')).toHaveLength(1)
  })

  it('uses the existing Dispatch route when an older home omits the Run ID', async () => {
    pair = createRunHomePair(1, true)
    expect(await pair.send('legacy-home')).toMatchObject({
      ok: true,
      result: { relay: { state: 'queued', homeRunId: null } }
    })
    await syncFederatedDispatch(pair.homeRuntime, pair.dispatch.id)
    expect(pair.homeDb.getUnreadRunMailbox(pair.run.id)).toHaveLength(1)
    expect(pair.workerDb.getRun(pair.run.id)).toBeUndefined()
  })
})
