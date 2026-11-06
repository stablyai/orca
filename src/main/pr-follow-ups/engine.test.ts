import { describe, expect, it, vi } from 'vitest'
import { FollowUpEngine, type FollowUpReceipt } from './engine'
import { FollowUpStore } from './store'
import type Database from '../sqlite/sync-database'
import { PR_FOLLOW_UP_METHODS } from '../runtime/rpc/methods/automations/pr-follow-ups'
import { harness } from './engine.test-fixture'

describe('automatic failing-check follow-ups', () => {
  it('waits for streamed observations and fences preparation with the latest received head', async () => {
    const h = harness()
    await h.engine.start()
    await h.engine.reconcile()
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.launch).not.toHaveBeenCalled()
    const green = {
      prKey: h.target.prKey,
      state: 'open' as const,
      headSha: 'h1',
      headRefName: 'fix',
      checksFinal: true,
      failingCheckNames: [],
      readComplete: true,
      observedAt: h.now
    }
    h.source.publish(green)
    await h.engine.reconcile([])
    h.prepare.mockImplementationOnce(async () => {
      h.source.publish({ ...green, headSha: 'h2', observedAt: h.now + 2 })
      return { agent: 'codex', target: { kind: 'existing', worktree: 'id:w1' } }
    })
    h.source.publish({ ...green, failingCheckNames: ['unit'], observedAt: h.now + 1 })
    await h.engine.reconcile([])
    await h.engine.reconcile([])
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.launch).not.toHaveBeenCalled()
    h.engine.forgetObservation(h.target.prKey)
    await h.engine.reconcile()
    expect(h.prepare).toHaveBeenCalledOnce()
    h.source.publish({
      ...green,
      headSha: 'h2',
      failingCheckNames: ['unit'],
      observedAt: h.now + 3
    })
    await h.engine.reconcile([])
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('baselines existing failures and fires once for each new failing name on a head, including after restart', async () => {
    const h = harness()
    await h.observe(['old'])
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.engine.view(h.target.prKey).state).toBe('baseline')
    await h.observe(['old', 'unit'])
    await h.observe(['unit', 'old'])
    await h.observe([])
    await h.observe(['unit'])
    await h.restart()
    await h.observe(['unit'])
    expect(h.launch).toHaveBeenCalledTimes(1)
    await h.observe(['unit', 'typecheck'])
    expect(h.launch).toHaveBeenCalledTimes(2)
    expect(h.store.actions(h.target.prKey).map((action) => action.failingNames)).toEqual(
      expect.arrayContaining([['unit'], ['typecheck']])
    )
    await h.observe(['unit'], 'h2')
    expect(h.launch).toHaveBeenCalledTimes(3)
  })

  it('waits for the first complete read after enabling instead of baselining stale cached green checks', async () => {
    const h = harness()
    h.global.enabled = false
    await h.observe([])
    h.global.enabled = true
    await h.engine.reconcile()
    await h.observe(['unit'])
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.engine.view(h.target.prKey).state).toBe('baseline')
    await h.observe(['unit', 'lint'])
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('retains handled names and safety history across disable, archive, stop and re-enable', async () => {
    const h = harness()
    await h.observe([])
    await h.observe(['unit'])
    h.global.enabled = false
    await h.engine.reconcile()
    h.global.enabled = true
    await h.engine.reconcile()
    h.target.archived = true
    await h.engine.reconcile()
    h.target.archived = false
    await h.engine.reconcile()
    await h.engine.stop(h.target.prKey, true)
    await h.observe(['unit', 'new'])
    await h.engine.stop(h.target.prKey, false)
    await h.observe(['unit', 'new'])
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(h.store.actions(h.target.prKey)).toHaveLength(1)
  })

  it.each(['chat', 'terminal'] as const)(
    'does not reset the cap for an attributed push or a %s working interval across restart and an incomplete read',
    async (surface) => {
      const h = harness()
      h.launch.mockResolvedValue({
        status: 'accepted',
        identity:
          surface === 'chat'
            ? { surface, sessionId: 'auto-1' }
            : { surface, terminalPtyId: 'auto-1', transcriptChatId: 'auto-1' }
      })
      await h.observe([])
      await h.observe(['one'])
      h.source.pushes = [
        {
          chatId: 'auto-1',
          headSha: 'h2',
          kind: 'pushed',
          anchor: { itemId: 'push', revision: 1 },
          observedAt: h.now
        }
      ]
      await h.observe(['one'], 'h2')
      await h.restart()
      await h.observe(['one'], 'h3')
      await h.observe(['one'], 'h4')
      expect(h.launch).toHaveBeenCalledTimes(3)
      expect(h.engine.view(h.target.prKey)).toMatchObject({
        state: 'paused',
        pauseReason: 'generation'
      })
      h.advance(120000)
      await h.observe(['one'], 'h5', { readComplete: false })
      await h.endSessions()
      await h.restart()
      await h.observe(['one'], 'h5')
      expect(h.launch).toHaveBeenCalledTimes(3)
      expect(h.engine.view(h.target.prKey)).toMatchObject({ state: 'paused', used: 3 })
      h.advance(120000)
      await h.observe([], 'h5')
      await h.observe(['one'], 'h6')
      expect(h.launch).toHaveBeenCalledTimes(4)
      expect(h.store.pr(h.target.prKey)?.generation).toBe(1)
    }
  )

  it('enforces six accepted launches per rolling day even when independent pushes reset generations', async () => {
    const h = harness()
    await h.observe([])
    for (const head of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']) {
      await h.observe(['unit'], head)
      if (head !== 'h7') {
        await h.endSessions()
        await h.observe([], head)
      }
    }
    expect(h.launch).toHaveBeenCalledTimes(6)
    expect(h.engine.view(h.target.prKey).state).toBe('paused')
    expect(h.engine.view(h.target.prKey)).toMatchObject({
      pauseReason: 'daily',
      resumesAt: 1700086402000
    })
    h.advance(24 * 60 * 60 * 1000)
    await h.engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(7)
  })

  it('drops held work when CI clears and rechecks the target incarnation after prompt preparation', async () => {
    const h = harness()
    await h.observe([])
    h.target.workingAgent = 'Claude'
    await h.observe(['unit'])
    expect(h.engine.view(h.target.prKey).state).toBe('waiting')
    await h.observe([])
    h.target.workingAgent = null
    await h.engine.reconcile()
    expect(h.launch).not.toHaveBeenCalled()
    h.prepare.mockImplementationOnce(async () => {
      h.target.instanceId = 'replacement'
      return { agent: 'codex', target: { kind: 'existing', worktree: 'id:w1' } }
    })
    await h.observe(['unit'])
    expect(h.launch).not.toHaveBeenCalled()
    await h.engine.reconcile()
    expect(h.launch).not.toHaveBeenCalled()
    await h.observe(['unit', 'lint'])
    expect(h.launch).not.toHaveBeenCalled()
    await h.observe(['unit', 'lint', 'new'])
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('cancels preparation when another eligible workspace becomes preferred without consuming its failure', async () => {
    const h = harness()
    const other = { ...h.target, worktreeId: 'w2', instanceId: 'i2', lastActiveAt: 0 }
    h.controls.targets = [h.target, other]
    await h.engine.reconcile()
    await h.observe([])
    h.prepare
      .mockImplementationOnce(async () => {
        other.lastActiveAt = 2
        h.engine.targetChanged(other)
        return { agent: 'codex', surface: 'chat', target: { kind: 'existing', worktree: 'id:w1' } }
      })
      .mockImplementationOnce(async (_observation, _names, target) => ({
        agent: 'codex',
        surface: 'chat',
        target: { kind: 'existing', worktree: `id:${target.worktreeId}` }
      }))
    await h.observe(['unit'])
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.store.pr(h.target.prKey)).toMatchObject({
      needsBaseline: false,
      baselineNames: [],
      handled: []
    })
    await h.engine.reconcile([h.target.prKey])
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: { kind: 'existing', worktree: 'id:w2' } })
    )
    expect(h.engine.forWorkspace('w2')?.view.state).toBe('handled')
  })

  it('holds terminal recipes until renderer publication is available, but lets chats launch', async () => {
    const h = harness()
    let available = false
    let surface: 'terminal' | 'chat' = 'terminal'
    const engine = new FollowUpEngine({
      ...h.dependencies(),
      recipe: () => ({ agent: 'Codex', surface }),
      canPublishAgentLaunchTab: () => available
    })
    await h.observe([])
    await engine.observe(h.source.latest(h.target.prKey)!)
    h.target.workingAgent = 'Claude'
    await h.observe(['unit'])
    await engine.observe(h.source.latest(h.target.prKey)!)
    h.target.workingAgent = null
    await engine.reconcile()
    expect(engine.view(h.target.prKey).state).toBe('waiting-window')
    expect(h.launch).not.toHaveBeenCalled()
    available = true
    await engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(1)
    available = false
    surface = 'chat'
    h.target.workingAgent = 'Claude'
    await h.observe(['unit', 'lint'])
    await engine.observe(h.source.latest(h.target.prKey)!)
    h.target.workingAgent = null
    await engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(2)
    await engine.dispose()
  })

  it('releases a busy hold on the next status transition without a new PR event', async () => {
    const h = harness()
    await h.observe([])
    h.target.workingAgent = 'Codex'
    await h.observe(['unit'])
    h.target.workingAgent = null
    await h.engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('uses a new operation attempt only after a definite absence; declined and uncertain actions stay handled', async () => {
    const h = harness()
    await h.observe([])
    h.launch.mockResolvedValueOnce({ status: 'absent' })
    await h.observe(['unit'])
    await h.engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(1)
    await h.observe(['unit'])
    expect(h.launch).toHaveBeenCalledTimes(2)
    expect(h.launch.mock.calls[0]?.[0].operationId).not.toEqual(
      h.launch.mock.calls[1]?.[0].operationId
    )
    h.launch.mockResolvedValueOnce({ status: 'declined' })
    await h.observe(['unit', 'lint'])
    await h.engine.reconcile()
    expect(h.launch).toHaveBeenCalledTimes(3)
    h.launch.mockResolvedValueOnce({ status: 'unconfirmed' })
    await h.observe(['unit', 'lint', 'tc'])
    await h.restart()
    await h.observe(['unit', 'lint', 'tc', 'another'])
    expect(h.launch).toHaveBeenCalledTimes(5)
    expect(h.engine.view(h.target.prKey).state).toBe('paused')
  })

  it.each<FollowUpReceipt>([
    { status: 'accepted', identity: { surface: 'chat', sessionId: 'recovered' } },
    { status: 'unconfirmed' }
  ])('recovers a crash after claim without dispatching again: $status', async (answer) => {
    const h = harness()
    await h.observe([])
    await h.observe(['unit'])
    const action = h.store.actions(h.target.prKey)[0]!
    action.status = 'claimed'
    delete action.sessionStartedAt
    h.store.saveAction(action)
    h.recover.mockResolvedValue(answer)
    await h.restart()
    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(h.store.actions(h.target.prKey)[0]?.status).toBe(answer.status)
  })

  it('releases an uncertain claim only after its durable receipt proves absence', async () => {
    const h = harness()
    await h.observe([])
    h.launch.mockResolvedValueOnce({ status: 'unconfirmed' })
    await h.observe(['unit'])
    h.recover.mockResolvedValue({ status: 'absent' })
    await h.restart()
    expect(h.launch).toHaveBeenCalledTimes(1)
    await h.observe(['unit'])
    expect(h.launch).toHaveBeenCalledTimes(2)
    expect(h.store.actions(h.target.prKey)[0]?.attempt).toBe(2)
  })

  it('honors Stop arriving while the prompt is being prepared', async () => {
    const h = harness()
    await h.observe([])
    let stopped: Promise<void> | undefined
    h.prepare.mockImplementationOnce(async () => {
      stopped = h.engine.stop(h.target.prKey, true)
      await stopped
      return { agent: 'codex', target: { kind: 'existing', worktree: 'id:w1' } }
    })
    await h.observe(['unit'])
    await stopped
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.engine.view(h.target.prKey).stopped).toBe(true)
  })

  it('uses the switch alone to enable defaults and explains each workspace’s own off reason', async () => {
    const h = harness()
    h.target.settings = { events: { ciFailed: 'off' } }
    const other = { ...h.target, worktreeId: 'w2', instanceId: 'i2', settings: { enabled: true } }
    const engine = new FollowUpEngine({
      ...h.dependencies(),
      targets: () => [h.target, other],
      globalSettings: () => ({ enabled: true })
    })
    await h.observe([])
    await engine.observe(h.source.latest(h.target.prKey)!)
    expect(engine.forWorkspace('w1')?.view).toMatchObject({ state: 'off', offReason: 'nothing' })
    expect(engine.forWorkspace('w2')?.view.state).toBe('armed')
    h.target.settings = { enabled: false }
    await engine.reconcile()
    expect(engine.forWorkspace('w1')?.view.offReason).toBe('disabled')
    h.target.settings = { enabled: true }
    h.target.branch = 'other'
    await engine.reconcile()
    expect(engine.forWorkspace('w1')?.view.offReason).toBe('branch')
    await engine.stop(h.target.prKey, true)
    expect(engine.forWorkspace('w2')?.view.offReason).toBe('stopped')
    await engine.dispose()
  })

  it('shows a launch in progress and limits prompt uncertainty to its live head without hiding actionable states', async () => {
    const h = harness()
    await h.observe([])
    h.launch.mockImplementationOnce(async () => {
      expect(h.engine.view(h.target.prKey)).toMatchObject({
        state: 'starting',
        workingAgent: 'codex'
      })
      return {
        status: 'accepted',
        identity: { surface: 'chat', sessionId: 'auto-1', promptUnconfirmed: true }
      }
    })
    await h.observe(['unit'])
    expect(h.engine.view(h.target.prKey).state).toBe('prompt-unconfirmed')
    await h.observe([])
    expect(h.engine.view(h.target.prKey).state).toBe('prompt-unconfirmed')
    h.target.workingAgent = 'Claude'
    await h.observe(['unit', 'lint'])
    expect(h.engine.view(h.target.prKey).state).toBe('waiting')
    await h.observe([], 'h2')
    expect(h.engine.view(h.target.prKey).state).toBe('armed')
    await h.observe([], 'h1')
    await h.endSessions()
    expect(h.engine.view(h.target.prKey).state).toBe('armed')
    h.target.workingAgent = null
    await h.observe(['a'])
    await h.observe(['a', 'b'])
    expect(h.engine.view(h.target.prKey).state).toBe('paused')
  })

  it('accepts draft observations without comment fields and attributes only pushed ownership records', async () => {
    const h = harness()
    await h.observe([], 'h1', { state: 'draft', baseSha: null, mergeable: undefined })
    await h.observe(['unit'], 'h1', { state: 'draft' })
    await h.endSessions()
    h.advance(1000)
    await h.observe([], 'h1')
    h.source.pushes = [
      {
        headSha: 'h2',
        chatId: 'auto-1',
        kind: 'opened',
        anchor: { itemId: 'open', revision: 1 },
        observedAt: h.now
      }
    ]
    await h.observe(['unit'], 'h2')
    expect(h.store.pr(h.target.prKey)?.generation).toBe(1)
    expect(h.launch).toHaveBeenCalledTimes(2)
  })

  it('serves the maintained projection while preparation and launch are outstanding', async () => {
    const h = harness()
    await h.observe([])
    let prepared!: () => void
    let releasePrepare!: () => void
    const preparing = new Promise<void>((resolve) => {
      prepared = resolve
    })
    h.prepare.mockImplementationOnce(async () => {
      prepared()
      await new Promise<void>((resolve) => {
        releasePrepare = resolve
      })
      return { agent: 'codex', surface: 'chat', target: { kind: 'existing', worktree: 'id:w1' } }
    })
    let launched!: () => void
    let releaseLaunch!: (receipt: FollowUpReceipt) => void
    const launching = new Promise<void>((resolve) => {
      launched = resolve
    })
    h.launch.mockImplementationOnce(() => {
      launched()
      return new Promise<FollowUpReceipt>((resolve) => {
        releaseLaunch = resolve
      })
    })
    const observation = h.observe(['unit'])
    await preparing
    expect(h.engine.snapshot().w1?.view.state).toBe('armed')
    expect(h.engine.forWorkspace('w1')).toEqual(h.engine.snapshot().w1)
    releasePrepare()
    await launching
    expect(h.engine.forWorkspace('w1')?.view).toMatchObject({ state: 'starting', used: 1 })
    expect(h.engine.view(h.target.prKey).state).toBe('starting')
    releaseLaunch({ status: 'accepted', identity: { sessionId: 'auto-1', surface: 'chat' } })
    await observation
    expect(h.engine.snapshot().w1?.view.state).toBe('handled')
  })

  it.each([10, 100])(
    'does not read or parse old launch prompts through get, observations or retirement (%i old actions)',
    async (count) => {
      const h = harness()
      await h.observe([])
      await h.observe(['unit'])
      const accepted = h.store.actions(h.target.prKey)[0]!
      h.launch.mockResolvedValueOnce({ status: 'unconfirmed' })
      await h.observe(['unit', 'lint'])
      const oldPrompt = 'irrelevant-old-launch-prompt:'.repeat(8192)
      for (let index = 0; index < count; index += 1) {
        const legacy = {
          ...accepted,
          actionKey: `old-${index}`,
          generation: -1,
          attemptStartedAt: 1699800000000,
          sessionStartedAt: 1699800000000,
          sessionEndedAt: 1699800010000,
          launch: { agent: 'codex', prompt: { text: oldPrompt, delivery: 'submit' } }
        }
        h.db
          .prepare('INSERT INTO followup_action VALUES (?, ?, ?)')
          .run(legacy.actionKey, legacy.prKey, JSON.stringify(legacy))
      }
      new FollowUpStore(h.db)
      let irrelevantSqlBytes = 0
      let irrelevantParsedBytes = 0
      const instrument = () => {
        const prepare = h.db.prepare.bind(h.db)
        vi.spyOn(h.db, 'prepare').mockImplementation((sql) => {
          const statement = prepare(sql)
          return new Proxy(statement, {
            get(target, key) {
              if (key !== 'all' && key !== 'get') {
                return Reflect.get(target, key)
              }
              return (...args: Database.BindValue[]) => {
                const result = statement[key](...args)
                for (const row of Array.isArray(result) ? result : result ? [result] : []) {
                  for (const value of Object.values(row)) {
                    if (
                      typeof value === 'string' &&
                      value.includes('irrelevant-old-launch-prompt:')
                    ) {
                      irrelevantSqlBytes += value.length
                    }
                  }
                }
                return result
              }
            }
          })
        })
      }
      instrument()
      const parse = JSON.parse
      const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        if (text.includes('irrelevant-old-launch-prompt:')) {
          irrelevantParsedBytes += text.length
        }
        return parse(text, reviver)
      })
      try {
        const get = PR_FOLLOW_UP_METHODS.find((method) => method.name === 'prFollowUps.get')!
        const read = async () => get.handler({}, { runtime: { prFollowUps: h.engine } } as never)
        expect((await read()).workspaces.w1?.view.used).toBe(2)
        await h.observe(['unit', 'lint', 'new'], 'h2')
        h.global.enabled = false
        await h.engine.reconcile()
        h.target.archived = true
        await h.engine.reconcile()
        await h.restart()
        instrument()
        expect((await read()).workspaces.w1?.view.used).toBe(3)
        expect(h.recover).toHaveBeenCalled()
        await h.observe(['unit'], 'h2')
        h.store.retire(h.store.pr(h.target.prKey)!)
        expect(irrelevantSqlBytes).toBe(0)
        expect(irrelevantParsedBytes).toBe(0)
        expect(h.launch).toHaveBeenCalledTimes(3)
      } finally {
        parseSpy.mockRestore()
      }
    }
  )

  it('keeps PR-wide safety history until every binding and pending session retires', async () => {
    const h = harness()
    await h.observe([])
    await h.observe(['unit'])
    h.store.bind(h.target.prKey, 'second-instance')
    h.store.reconcileBindings(new Set(['second-instance']))
    const pr = h.store.pr(h.target.prKey)!
    expect(h.store.retire(pr)).toBe(false)
    pr.state = 'merged'
    h.store.savePr(pr)
    expect(h.store.retire(pr)).toBe(false)
    await h.endSessions()
    pr.state = 'merged'
    h.store.savePr(pr)
    expect(h.store.retire(pr)).toBe(true)
    expect(h.store.actions(h.target.prKey)).toEqual([])
  })
})
