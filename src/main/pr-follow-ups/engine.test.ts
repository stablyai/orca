import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import { FollowUpEngine, type FollowUpEngineDependencies, type FollowUpReceipt } from './engine'
import { FollowUpStore } from './store'

class FakeObservations implements FollowUpObservationSource {
  watchWorkspace(): () => void {
    return () => undefined
  }
  observations = new Map<string, FollowUpObservation>()
  pushes: { headSha: string; chatId: string }[] = []
  subscribe(): () => void {
    return () => undefined
  }
  latest(key: string): FollowUpObservation | undefined {
    return this.observations.get(key)
  }
  pullRequestActionsFor(): typeof this.pushes {
    return this.pushes
  }
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'pr-followups-pr1-'))
  const path = join(folder, 'host.db')
  let store = FollowUpStore.open(path)
  const source = new FakeObservations()
  let now = 1700000000000
  const target: FollowUpTarget = {
    worktreeId: 'w1',
    instanceId: 'i1',
    prKey: 'github.com/a/b#1',
    branch: 'fix',
    lastActiveAt: 1,
    archived: false,
    workingAgent: null
  }
  const global = { enabled: true, events: { ciFailed: 'new-agent' } }
  const launch = vi
    .fn<FollowUpEngineDependencies['launch']>()
    .mockResolvedValue({ status: 'accepted', identity: { surface: 'chat', sessionId: 'auto-1' } })
  const recover = vi
    .fn<FollowUpEngineDependencies['recover']>()
    .mockResolvedValue({ status: 'unconfirmed' })
  const prepare = vi
    .fn<FollowUpEngineDependencies['prepare']>()
    .mockResolvedValue({ agent: 'codex', target: { kind: 'existing', worktree: 'id:w1' } })
  const deps = (): FollowUpEngineDependencies => ({
    store,
    source,
    globalSettings: () => global,
    targets: () => [target],
    liveInstanceIds: () => new Set([target.instanceId]),
    recipe: () => ({ agent: 'Codex', surface: 'chat' }),
    canPublishAgentLaunchTab: () => true,
    working: () => false,
    launch,
    recover,
    prepare,
    live: async () => 'unknown',
    now: () => now
  })
  let engine = new FollowUpEngine(deps())
  const observe = async (
    names: string[],
    head = 'h1',
    patch: Partial<FollowUpObservation> = {}
  ) => {
    now += 1000
    const observation: FollowUpObservation = {
      prKey: target.prKey,
      state: 'open',
      headSha: head,
      headRefName: 'fix',
      baseSha: 'base',
      mergeable: 'clean',
      checksFinal: true,
      failingCheckNames: names,
      commentSignal: {
        comments: { totalCount: 0, newestIds: [] },
        reviews: { totalCount: 0, newestIds: [] },
        threads: { totalCount: 0, newestIds: [] }
      },
      readComplete: true,
      observedAt: now,
      ...patch
    }
    source.observations.set(target.prKey, observation)
    await engine.observe(observation)
  }
  cleanups.push(() => {
    store.close()
    rmSync(folder, { recursive: true, force: true })
  })
  return {
    source,
    target,
    launch,
    prepare,
    recover,
    global,
    observe,
    get engine() {
      return engine
    },
    get store() {
      return store
    },
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    dependencies: deps,
    restart: async () => {
      await engine.dispose()
      store.close()
      store = FollowUpStore.open(path)
      engine = new FollowUpEngine(deps())
      await engine.start()
    }
  }
}

describe('automatic failing-check follow-ups', () => {
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
    expect(h.store.actions(h.target.prKey).map((action) => action.failingNames)).toEqual([
      ['unit'],
      ['typecheck']
    ])
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

  it('does not reset the cap for an attributed follow-up push or a session interval overlapping across restart', async () => {
    const h = harness()
    await h.observe([])
    await h.observe(['one'])
    h.source.pushes = [{ chatId: 'auto-1', headSha: 'h2' }]
    await h.observe(['one'], 'h2')
    await h.restart()
    await h.observe(['one'], 'h3')
    await h.observe(['one'], 'h4')
    expect(h.launch).toHaveBeenCalledTimes(3)
    expect(h.engine.view(h.target.prKey)).toMatchObject({
      state: 'paused',
      pauseReason: 'generation'
    })
    await h.engine.sessionEnded('auto-1', 1700000100000)
    h.advance(120000)
    await h.observe([], 'h4')
    await h.observe(['one'], 'h5')
    expect(h.launch).toHaveBeenCalledTimes(4)
    expect(h.store.pr(h.target.prKey)?.generation).toBe(1)
  })

  it('enforces six accepted launches per rolling day even when independent pushes reset generations', async () => {
    const h = harness()
    await h.observe([])
    for (const head of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']) {
      await h.observe(['unit'], head)
      await h.engine.sessionEnded('auto-1', 1700000000000)
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
    h.target.workingAgent = 'Claude'
    await h.observe(['unit'])
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
    expect(h.launch).toHaveBeenCalledTimes(4)
    expect(h.engine.view(h.target.prKey).state).toBe('unconfirmed')
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
    expect(h.launch).toHaveBeenCalledTimes(2)
    expect(h.store.actions(h.target.prKey)[0]?.attempt).toBe(2)
  })

  it('honors Stop arriving while the prompt is being prepared', async () => {
    const h = harness()
    await h.observe([])
    let stopped: Promise<void> | undefined
    h.prepare.mockImplementationOnce(async () => {
      stopped = h.engine.stop(h.target.prKey, true)
      return { agent: 'codex', target: { kind: 'existing', worktree: 'id:w1' } }
    })
    await h.observe(['unit'])
    await stopped
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.engine.view(h.target.prKey).stopped).toBe(true)
  })

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
    await h.engine.sessionEnded('auto-1', 1700000100000)
    pr.state = 'merged'
    h.store.savePr(pr)
    expect(h.store.retire(pr)).toBe(true)
    expect(h.store.actions(h.target.prKey)).toEqual([])
  })
})
