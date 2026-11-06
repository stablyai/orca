import { expect, it } from 'vitest'
import { FollowUpEngine } from './engine'
import { harness } from './engine.test-fixture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([false, true])(
  'uses all admitted journal evidence when a head is already queued behind deferred liveness (overlap=%s)',
  async (overlap) => {
    const h = harness()
    await h.observe([])
    await h.observe(['unit'])
    const start = h.now
    const pr = h.store.pr(h.target.prKey)!
    pr.lastSeenAt = start + (overlap ? 5 : 15)
    h.store.savePr(pr)
    await h.engine.dispose()
    const entered = deferred<void>()
    const sample = deferred<boolean>()
    let calls = 0
    const engine = new FollowUpEngine({
      ...h.dependencies(),
      live: async () => {
        if (calls++ === 0) {
          entered.resolve()
          return sample.promise
        }
        return true
      },
      working: () => ({ working: false, at: start + 30 })
    })
    const reconciling = engine.reconcile([h.target.prKey])
    await entered.promise
    const next = {
      ...h.source.latest(h.target.prKey)!,
      headSha: 'h2',
      observedAt: start + 18,
      failingCheckNames: []
    }
    h.source.observations.set(h.target.prKey, next)
    const head = engine.observe(next)
    for (const [working, offset] of [
      [false, 10],
      [true, 20],
      [false, 30]
    ] as const) {
      engine.activityObserved('w1', 'auto-1', working, start + offset)
    }
    sample.resolve(true)
    await reconciling
    await head
    expect(h.store.pr(h.target.prKey)?.generation).toBe(overlap ? 0 : 1)
    await engine.dispose()
  }
)

it('initializes admission from persisted obligations before the first projection and rejects stale disappearance', async () => {
  const h = harness()
  await h.observe([])
  await h.observe(['unit'])
  const start = h.now
  const entered = deferred<void>()
  const sample = deferred<boolean>()
  const restarting = h.restart((deps) => ({
    ...deps,
    live: async () => {
      entered.resolve()
      return sample.promise
    }
  }))
  await entered.promise
  expect(h.engine.snapshot().w1).toBeNull()
  h.engine.activityObserved('w1', 'auto-1', false, start + 10)
  h.engine.activityObserved('w1', 'auto-1', true, start + 20)
  sample.resolve(false)
  await restarting
  expect(h.store.latestAction(h.target.prKey)?.sessionEndedAt).toBeUndefined()
  expect(h.store.workingOverlap(h.target.prKey, start + 15, start + 18)).toBe(false)
  expect(h.store.workingOverlap(h.target.prKey, start + 21, start + 25)).toBe(true)
  // Reopen after synchronous admission, without a reconciliation processing those events.
  await h.restart()
  expect(h.store.workingOverlap(h.target.prKey, start + 15, start + 18)).toBe(false)
  expect(h.store.workingOverlap(h.target.prKey, start + 21, start + 25)).toBe(true)
})

it('captures identity-specific evidence before acceptance and recovers it after restart without another launch', async () => {
  const h = harness()
  await h.observe([])
  const entered = deferred<void>()
  const receipt = deferred<{ status: 'unconfirmed' }>()
  h.launch.mockImplementationOnce(async () => {
    entered.resolve()
    return receipt.promise
  })
  const launching = h.observe(['unit'])
  await entered.promise
  const start = h.now
  h.controls.targets = []
  h.engine.refreshInventory()
  for (const [identity, working, offset] of [
    ['late', true, 5],
    ['other', false, 8],
    ['late', false, 10],
    ['late', true, 20],
    ['other', false, 25]
  ] as const) {
    h.engine.activityObserved('w1', identity, working, start + offset)
  }
  expect(h.store.latestAction(h.target.prKey)?.status).toBe('claimed')
  receipt.resolve({ status: 'unconfirmed' })
  await launching
  await h.restart()
  h.engine.activityObserved('w1', 'late', false, start + 30)
  h.recover.mockResolvedValueOnce({
    status: 'accepted',
    identity: { sessionId: 'late', surface: 'chat' }
  })
  await h.engine.reconcile(h.engine.prKeysForAuthorities([], ['i1']))
  expect(h.launch).toHaveBeenCalledOnce()
  expect(h.store.workingOverlap(h.target.prKey, start + 15, start + 18)).toBe(false)
  expect(h.store.workingOverlap(h.target.prKey, start + 21, start + 28)).toBe(true)
  h.controls.live = false
  h.advance(1000)
  await h.engine.reconcile([h.target.prKey])
  expect(h.store.latestAction(h.target.prKey)?.sessionEndedAt).toBe(h.now)
  expect(h.store.workingOverlap(h.target.prKey, h.now + 1, h.now + 5)).toBe(false)
})

it('keeps an owed held failure across a batch relink and instance replacement while another eligible binding survives', async () => {
  const h = harness()
  const b = { ...h.target, worktreeId: 'w2', instanceId: 'i2', lastActiveAt: 2 }
  h.controls.targets = [h.target, b]
  await h.engine.reconcile()
  await h.observe([])
  h.target.workingAgent = 'Codex'
  b.workingAgent = 'Codex'
  await h.observe(['unit'])
  const replacement = { ...h.target, instanceId: 'i3' }
  const relink = { ...b, worktreeId: 'w3', instanceId: 'i4' }
  h.controls.targets = [replacement, b, relink]
  h.engine.targetsChanged([replacement, relink], [])
  await h.engine.reconcile([h.target.prKey])
  expect(h.store.pr(h.target.prKey)?.needsBaseline).toBe(false)
  expect(h.launch).not.toHaveBeenCalled()
  b.workingAgent = null
  h.engine.targetChanged(b)
  await h.engine.reconcile([h.target.prKey])
  expect(h.launch).toHaveBeenCalledOnce()
  expect(h.store.latestAction(h.target.prKey)?.worktreeId).toBe('w2')
})

it('drops prepared work after a replacement without baselining an eligible surviving workspace', async () => {
  const h = harness()
  const b = { ...h.target, worktreeId: 'w2', instanceId: 'i2', lastActiveAt: 0 }
  h.controls.targets = [h.target, b]
  await h.engine.reconcile()
  await h.observe([])
  h.prepare.mockImplementationOnce(async () => {
    const replacement = { ...h.target, instanceId: 'replacement', lastActiveAt: -1 }
    h.controls.targets = [replacement, b]
    h.engine.targetsChanged([replacement], [])
    return { agent: 'codex', surface: 'chat', target: { kind: 'existing', worktree: 'id:w1' } }
  })
  await h.observe(['unit'])
  expect(h.launch).not.toHaveBeenCalled()
  expect(h.store.pr(h.target.prKey)?.needsBaseline).toBe(false)
  await h.engine.reconcile([h.target.prKey])
  expect(h.launch).toHaveBeenCalledOnce()
  expect(h.store.latestAction(h.target.prKey)?.worktreeId).toBe('w2')
})
