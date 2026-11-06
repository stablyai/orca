import { describe, expect, it, vi } from 'vitest'
import { FollowUpEngine } from './engine'
import { harness } from './engine.test-fixture'

describe('follow-up recovery and instance lifecycle', () => {
  it('finalizes uncertainty once, retains reservations and dedupe across restart, and retires it after close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    await h.observe([])
    h.launch.mockResolvedValue({ status: 'unconfirmed' })
    await h.observe(['unit'])
    await h.restart()
    h.recover.mockResolvedValueOnce({
      status: 'accepted',
      identity: { surface: 'chat', sessionId: 'late' }
    })
    await h.engine.reconcile()
    expect(h.store.latestAction(h.target.prKey)?.sessionId).toBe('late')
    await h.observe(['unit', 'lint'])
    await h.observe(['lint'], 'h2')
    expect(h.launch).toHaveBeenCalledTimes(3)
    expect(h.engine.view(h.target.prKey)).toMatchObject({ state: 'paused', used: 3 })
    h.advance(49 * 60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(49 * 60 * 60 * 1000)
    await h.engine.reconcile([])
    const recovered = h.recover.mock.calls.length
    await h.engine.reconcile()
    await h.restart()
    await h.observe(['lint'], 'h2')
    expect(h.recover).toHaveBeenCalledTimes(recovered)
    expect(h.launch).toHaveBeenCalledTimes(3)
    expect(
      h.store.actions(h.target.prKey).filter((action) => action.recoveryFinalizedAt)
    ).toHaveLength(2)
    await h.observe(['lint'], 'h2', { state: 'closed' })
    expect(h.store.pr(h.target.prKey)).toBeDefined()
    await h.engine.sessionEnded('late', h.now)
    expect(h.store.pr(h.target.prKey)).toBeUndefined()
  })

  it('parks effect-free failures through restart, caps fresh-read retries and resets only effective inputs', async () => {
    const h = harness()
    await h.observe([])
    h.launch.mockResolvedValue({ status: 'absent' })
    await h.observe(['unit'])
    await h.engine.reconcile()
    await h.engine.reconcile()
    expect(h.prepare).toHaveBeenCalledTimes(1)
    await h.observe(['unit'])
    await h.observe(['unit'])
    await h.observe(['unit'])
    expect(h.prepare).toHaveBeenCalledTimes(3)
    await h.restart()
    h.target.lastActiveAt += 1
    await h.engine.reconcile()
    await h.observe(['unit'])
    expect(h.prepare).toHaveBeenCalledTimes(3)
    expect(h.engine.view(h.target.prKey)).toMatchObject({
      state: 'failed',
      workingAgent: 'codex',
      used: 0
    })
    h.controls.key = 'codex:model-changed'
    await h.engine.reconcile()
    expect(h.prepare).toHaveBeenCalledTimes(4)
    h.controls.key = 'codex:now-available'
    h.launch.mockResolvedValue({ status: 'accepted', identity: { sessionId: 'ready' } })
    await h.engine.reconcile()
    expect(h.prepare).toHaveBeenCalledTimes(5)
    expect(h.store.latestAction(h.target.prKey)).toMatchObject({
      attempt: 5,
      status: 'accepted',
      retryCount: 1
    })
    expect(new Set(h.launch.mock.calls.map(([params]) => params.operationId)).size).toBe(5)
  })

  it.each(['chat', 'terminal'] as const)(
    'preserves working gaps and unknown evidence independently of live %s tabs',
    async (surface) => {
      const h = harness()
      h.launch.mockResolvedValue({
        status: 'accepted',
        identity:
          surface === 'chat'
            ? { surface, sessionId: 'auto-1' }
            : { surface, terminalPtyId: 'pty-1', paneKey: 'pane-1', transcriptChatId: 'auto-1' }
      })
      await h.observe([])
      await h.observe(['one'])
      await h.observe(['one', 'two'])
      await h.observe(['one', 'two', 'three'])
      await h.observe(['one'], 'h2')
      expect(h.engine.view(h.target.prKey).used).toBe(3)
      h.advance(1000)
      await h.engine.activityObserved('w1', surface === 'chat' ? 'auto-1' : 'pane-1', false, h.now)
      await h.observe([], 'h2')
      const inGap = h.now + 1000
      h.advance(5000)
      await h.engine.activityObserved('w1', surface === 'chat' ? 'auto-1' : 'pane-1', true, h.now)
      await h.observe([], 'h3', { observedAt: inGap })
      expect(h.store.pr(h.target.prKey)?.generation).toBe(1)
      await h.observe(['one'], 'h4')
      expect(h.store.pr(h.target.prKey)?.generation).toBe(1)
      h.advance(1000)
      await h.engine.activityObserved('w1', surface === 'chat' ? 'auto-1' : 'pane-1', false, h.now)
      await h.observe([], 'h4')
      await h.restart()
      await h.observe([], 'h5')
      expect(h.store.pr(h.target.prKey)?.generation).toBe(2)
      h.source.pushes = [
        {
          chatId: 'auto-1',
          headSha: 'h6',
          kind: 'pushed',
          anchor: { itemId: 'push', revision: 1 },
          observedAt: h.now
        }
      ]
      await h.observe([], 'h6')
      expect(h.store.pr(h.target.prKey)?.generation).toBe(2)
      expect(
        h.store.actions(h.target.prKey).every((action) => action.sessionEndedAt === undefined)
      ).toBe(true)
    }
  )

  it('isolates synchronous recipe and asynchronous preparation failures by effective project recipe', async () => {
    const h = harness()
    await h.observe([])
    h.controls.recipeInvalid = true
    await h.observe(['unit'])
    expect(h.store.latestAction(h.target.prKey)).toMatchObject({ status: 'failed', agent: 'codex' })
    await h.engine.reconcile()
    expect(h.prepare).not.toHaveBeenCalled()
    h.controls.recipeInvalid = false
    h.controls.key = 'repaired-project-override'
    h.prepare.mockRejectedValueOnce(new Error('Check logs unavailable'))
    await h.engine.reconcile()
    expect(h.store.latestAction(h.target.prKey)?.status).toBe('failed')
    await h.engine.reconcile()
    expect(h.prepare).toHaveBeenCalledTimes(1)
    h.controls.key = 'repaired-log-access'
    await h.engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('defers the complete inventory sweep and deletes only immutable instances without erasing shared safety history', async () => {
    const h = harness()
    await h.observe([])
    await h.observe(['unit'])
    h.store.bind(h.target.prKey, 'archived-disconnected')
    h.controls.targets = []
    h.controls.liveIds = new Set()
    await h.restart()
    expect(h.store.pr(h.target.prKey)?.generation).toBe(0)
    expect(h.store.acceptedCount(h.target.prKey, 0)).toBe(1)
    h.controls.targets = [{ ...h.target, instanceId: 'replacement', archived: true }]
    h.controls.liveIds = new Set(['replacement', 'archived-disconnected'])
    await h.engine.reconcile()
    expect(
      h.db
        .prepare('SELECT instance_id FROM followup_binding ORDER BY instance_id')
        .all()
        .map((row) => row.instance_id)
    ).toEqual(['archived-disconnected', 'i1', 'replacement'])
    h.controls.complete = true
    await h.engine.reconcile()
    expect(
      h.db
        .prepare('SELECT instance_id FROM followup_binding ORDER BY instance_id')
        .all()
        .map((row) => row.instance_id)
    ).toEqual(['archived-disconnected', 'replacement'])
    await h.engine.instanceDeleted('i1')
    await h.engine.sessionEnded('auto-1', h.now)
    expect(h.store.pr(h.target.prKey)).toBeDefined()
    await h.engine.instanceDeleted('archived-disconnected')
    expect(h.store.pr(h.target.prKey)).toBeDefined()
    h.controls.targets = []
    h.engine.refreshInventory()
    h.controls.liveIds = new Set()
    await h.engine.reconcile()
    expect(h.store.pr(h.target.prKey)).toBeDefined()
    await h.engine.instanceDeleted('replacement')
    expect(h.store.pr(h.target.prKey)).toBeUndefined()
  })
  it.each(['inputs', 'recipe', 'prepare'])(
    'continues to the next project after a %s failure and recovers only the repaired effective recipe',
    async (failure) => {
      const h = harness()
      await h.observe([])
      const other = { ...h.target, worktreeId: 'w2', instanceId: 'i2', prKey: 'github.com/a/b#2' }
      let broken = true
      const engine = new FollowUpEngine({
        ...h.dependencies(),
        targets: () => [h.target, other],
        launchInputs: (target) => {
          if (broken && failure === 'inputs' && target.worktreeId === 'w1') {
            throw new Error('Unsafe adapter details')
          }
          return { key: `${target.instanceId}:${broken}`, agent: 'codex' }
        },
        recipe: (target) => {
          if (broken && failure === 'recipe' && target.worktreeId === 'w1') {
            throw new Error('Invalid global recipe')
          }
          return { agent: 'codex', surface: 'chat' }
        },
        prepare: async (observation, names, target) => {
          if (broken && failure === 'prepare' && target.worktreeId === 'w1') {
            throw new Error('Check logs unavailable')
          }
          return h.prepare(observation, names, target)
        }
      })
      const green = { ...h.source.latest(h.target.prKey)!, prKey: other.prKey }
      h.source.observations.set(other.prKey, green)
      await engine.observe(green)
      for (const target of [h.target, other]) {
        h.source.observations.set(target.prKey, {
          ...green,
          prKey: target.prKey,
          failingCheckNames: ['unit'],
          observedAt: h.now + 1000
        })
      }
      await engine.reconcile()
      expect(h.store.latestAction(h.target.prKey)).toMatchObject({
        status: 'failed',
        failureReason:
          failure === 'inputs'
            ? 'Codex could not prepare the check fix. Review the Fix checks recipe in Source Control AI settings, then use Fix checks.'
            : failure === 'recipe'
              ? 'Codex could not prepare the check fix. Review the Fix checks recipe in Source Control AI settings, then use Fix checks.'
              : 'Codex could not load the check-fix prompt. Check your connection, then use Fix checks.'
      })
      expect(engine.forWorkspace('w1')?.view.failureReason).toBe(
        failure === 'inputs'
          ? 'Codex could not prepare the check fix. Review the Fix checks recipe in Source Control AI settings, then use Fix checks.'
          : failure === 'recipe'
            ? 'Codex could not prepare the check fix. Review the Fix checks recipe in Source Control AI settings, then use Fix checks.'
            : 'Codex could not load the check-fix prompt. Check your connection, then use Fix checks.'
      )
      expect(h.store.latestAction(other.prKey)?.status).toBe('accepted')
      expect(h.launch).toHaveBeenCalledTimes(1)
      await engine.reconcile()
      expect(h.launch).toHaveBeenCalledTimes(1)
      broken = false
      await engine.reconcile()
      expect(h.launch).toHaveBeenCalledTimes(2)
      expect(h.store.latestAction(h.target.prKey)?.status).toBe('accepted')
      await engine.dispose()
    }
  )
  it('keeps the receipt failure explanation through settlement and parked reconciliation', async () => {
    const h = harness()
    await h.observe([])
    h.launch.mockResolvedValueOnce({ status: 'unconfirmed' })
    await h.observe(['unit'])
    h.recover.mockResolvedValueOnce({
      status: 'absent',
      failureReason:
        'Codex could not open this workspace. Reopen the workspace, then use Fix checks.'
    })
    await h.engine.reconcile([h.target.prKey])
    expect(h.engine.view(h.target.prKey)).toMatchObject({
      state: 'failed',
      workingAgent: 'codex',
      failureReason:
        'Codex could not open this workspace. Reopen the workspace, then use Fix checks.'
    })
    await h.engine.reconcile([h.target.prKey])
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.store.latestAction(h.target.prKey)?.failureReason).toBe(
      'Codex could not open this workspace. Reopen the workspace, then use Fix checks.'
    )
  })

  it('reserves the rolling daily allowance for uncertain launches even across independent heads', async () => {
    const h = harness()
    await h.observe([])
    h.launch.mockResolvedValue({ status: 'unconfirmed' })
    for (const head of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']) {
      await h.observe(['unit'], head)
    }
    expect(h.launch).toHaveBeenCalledTimes(6)
    expect(h.engine.view(h.target.prKey)).toMatchObject({ state: 'paused', pauseReason: 'daily' })
    await h.restart()
    await h.observe(['unit'], 'h7')
    expect(h.launch).toHaveBeenCalledTimes(6)
    await h.observe(['unit'], 'h7', { state: 'closed' })
    h.controls.targets = []
    h.engine.refreshInventory()
    await h.engine.instanceDeleted('i1')
    expect(h.store.pr(h.target.prKey)).toBeDefined()
  })

  it.each(['chat', 'terminal'] as const)(
    'requires every automatic %s agent to stop working before an independent push resets the cap',
    async (surface) => {
      const h = harness()
      let session = 0
      h.launch.mockImplementation(async () => ({
        status: 'accepted',
        identity:
          surface === 'chat'
            ? { surface, sessionId: `auto-${++session}` }
            : { surface, paneKey: `pane-${++session}` }
      }))
      await h.observe([])
      await h.observe(['a'])
      await h.observe(['a', 'b'])
      await h.observe(['a', 'b', 'c'])
      for (const id of [1, 2]) {
        h.advance(1000)
        await h.engine.activityObserved(
          'w1',
          surface === 'chat' ? `auto-${id}` : `pane-${id}`,
          false,
          h.now
        )
      }
      await h.observe([])
      await h.observe(['a'], 'h2')
      expect(h.engine.view(h.target.prKey)).toMatchObject({ state: 'paused', used: 3 })
      h.advance(1000)
      await h.engine.activityObserved('w1', surface === 'chat' ? 'auto-3' : 'pane-3', false, h.now)
      await h.observe([], 'h2')
      await h.observe(['a'], 'h3')
      expect(h.engine.view(h.target.prKey).used).toBe(1)
      expect(h.launch).toHaveBeenCalledTimes(4)
    }
  )
  it('releases deleted-instance safety history on the launched terminal’s later authoritative lifecycle observation', async () => {
    const h = harness()
    h.launch.mockResolvedValue({
      status: 'accepted',
      identity: { surface: 'terminal', paneKey: 'pane-1', terminalPtyId: 'pty-1' }
    })
    await h.observe([])
    await h.observe(['unit'])
    h.controls.targets = []
    h.engine.refreshInventory()
    await h.engine.instanceDeleted('i1')
    expect(h.store.pr(h.target.prKey)).toBeDefined()
    h.controls.live = false
    const keys = h.engine.activityObserved('w1', 'pane-1', 'unknown', h.now)
    await h.engine.reconcile(keys)
    expect(h.store.pr(h.target.prKey)).toBeUndefined()
  })
})
