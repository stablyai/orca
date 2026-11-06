import { afterEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type {
  FollowUpHostInputs,
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget,
  FollowUpWorkspace
} from '../../shared/pr-follow-ups/contracts'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { installPrFollowUps } from './install'
import { FollowUpStore } from './store'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'

vi.mock('./launch', () => ({
  launchFollowUp: vi.fn(),
  recoverFollowUpLaunch: vi.fn().mockResolvedValue({ status: 'unconfirmed' })
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

function installation(count: number, unresolved = false) {
  const db = new Database(':memory:')
  const records = new FollowUpStore(db)
  const now = Date.now()
  let enabled = !unresolved
  let targets: FollowUpTarget[] = Array.from({ length: count }, (_, index) => ({
    worktreeId: `w${index}`,
    instanceId: `i${index}`,
    prKey: `pr${index}`,
    branch: 'fix',
    archived: false,
    lastActiveAt: index,
    workingAgent: null
  }))
  let workspaces: FollowUpWorkspace[] = targets.map((target) => ({
    instanceId: target.instanceId,
    worktreeId: target.worktreeId,
    repoId: 'repo',
    branch: 'fix',
    connectionId: null,
    prNumber: null,
    archived: false
  }))
  if (unresolved) {
    targets = []
  }
  const observations = new Map<string, FollowUpObservation>()
  for (const target of targets) {
    observations.set(target.prKey, {
      prKey: target.prKey,
      headSha: 'h1',
      headRefName: 'fix',
      state: 'open',
      readComplete: true,
      checksFinal: true,
      failingCheckNames: [],
      observedAt: now
    })
    records.savePr({
      prKey: target.prKey,
      headSha: 'h1',
      baselineAt: now,
      needsBaseline: false,
      handled: [],
      baselineNames: [],
      lastSeenAt: now,
      state: 'open',
      generation: 0,
      stoppedAt: null,
      consecutiveReadFailures: 0,
      pendingRead: false
    })
    records.bind(target.prKey, target.instanceId)
    records.saveAction({
      actionKey: `active-${target.prKey}`,
      prKey: target.prKey,
      headSha: 'h1',
      failingNames: ['old'],
      mode: 'new-agent',
      worktreeId: target.worktreeId,
      instanceId: target.instanceId,
      generation: 0,
      attempt: 1,
      attemptStartedAt: now - 100,
      operationId: `old-${target.prKey}`,
      status: 'accepted',
      agent: 'codex',
      surface: 'terminal',
      paneKey: `pane-${target.worktreeId}`,
      sessionStartedAt: now - 100,
      workingIntervals: [{ start: now - 100 }]
    })
  }
  if (targets[0]) {
    records.saveAction({
      ...records.action('active-pr0')!,
      actionKey: 'uncertain-pr0',
      status: 'unconfirmed',
      paneKey: undefined,
      attemptStartedAt: now - 50
    })
  }
  let inventory!: Parameters<FollowUpHostInputs['subscribeInventory']>[0]
  let settings!: (updates: Record<string, unknown>) => void
  let transition!: (event: AgentPaneChange) => void
  let clientEvent!: (event: RuntimeClientEvent) => void
  let observation!: (event: FollowUpObservation) => void
  const handles: ReturnType<typeof vi.fn>[] = []
  const prepare = vi
    .fn<FollowUpHostInputs['prepare']>()
    .mockImplementation(async (_o, _n, target) => ({
      agent: 'codex',
      surface: 'chat',
      target: { kind: 'existing', worktree: `id:${target.worktreeId}` }
    }))
  const inputs: FollowUpHostInputs = {
    workspaces: () => workspaces,
    targets: () => targets,
    target: (id) => targets.find((item) => item.worktreeId === id),
    subscribeInventory: (listener) => {
      inventory = listener
      return () => {}
    },
    liveInstanceIds: () => new Set(workspaces.map((item) => item.instanceId)),
    inventoryComplete: () => true,
    launchInputs: () => ({ key: 'codex:chat', agent: 'codex' }),
    recipe: () => ({ agent: 'codex', surface: 'chat' }),
    working: () => 'unknown',
    live: vi.fn().mockResolvedValue(true),
    prepare
  }
  const source: FollowUpObservationSource = {
    registerPRWatch: () => {
      const unregister = vi.fn()
      handles.push(unregister)
      return { unregister }
    },
    latest: (key) => observations.get(key),
    subscribePRObservations: (listener) => {
      observation = listener
      return () => {}
    }
  }
  vi.mocked(launchFollowUp)
    .mockClear()
    .mockResolvedValue({
      status: 'accepted',
      identity: { sessionId: 'new-agent', surface: 'chat' }
    })
  const host = installPrFollowUps(
    {
      getOrchestrationDb: () => ({ db }),
      canPublishAgentLaunchTab: () => true,
      onWorktreeLifecycle: () => () => {},
      onClientEvent: (listener: typeof clientEvent) => {
        clientEvent = listener
        return () => {}
      },
      agentTransitions: {
        subscribe: (listener: typeof transition) => {
          transition = listener
          return () => {}
        }
      }
    } as unknown as OrcaRuntimeService,
    {
      getSettings: () => ({ prFollowUps: { enabled } }),
      onSettingsChanged: (listener: typeof settings) => {
        settings = listener
        return () => {}
      }
    } as unknown as RuntimeStore,
    source,
    inputs,
    () => () => {},
    () => {}
  )
  const flush = async () => {
    await host.engine.reconcile([])
    await new Promise<void>((resolve) => setImmediate(resolve))
    await host.engine.reconcile([])
  }
  cleanups.push(async () => {
    await host.dispose()
    db.close()
  })
  return {
    ...host,
    records,
    db,
    now,
    prepare,
    inputs,
    handles,
    flush,
    observe: (names: string[]) => {
      const next = { ...observations.get('pr0')!, observedAt: now + 1, failingCheckNames: names }
      observations.set('pr0', next)
      observation(next)
    },
    status: (working: boolean, at: number) => {
      targets[0] = { ...targets[0]!, workingAgent: working ? 'Codex' : null }
      transition({
        kind: 'moved',
        workspace: { worktreeId: 'w0', sshHostId: null },
        paneKey: 'pane-w0',
        from: working ? 'done' : 'working',
        to: working ? 'working' : 'done',
        transition: null,
        at
      })
    },
    global: (value: boolean) => {
      enabled = value
      settings({ prFollowUps: { enabled } })
    },
    project: (value: boolean) => {
      workspaces = workspaces.map((item) => ({ ...item, settings: { enabled: value } }))
      clientEvent({ type: 'reposChanged' })
    },
    unchanged: () => {
      inventory({})
      clientEvent({ type: 'worktreesChanged', repoId: 'repo' })
    },
    relink: () => {
      targets = targets.map((item, index) => (index ? item : { ...item, prKey: 'new-pr' }))
      workspaces = workspaces.map((item, index) => (index ? item : { ...item, prNumber: 42 }))
      inventory({})
    }
  }
}

it('reconciles unresolved discovery watches through global and project settings listeners', async () => {
  const h = installation(1, true)
  await h.flush()
  expect(h.handles).toHaveLength(0)
  h.global(true)
  await h.flush()
  expect(h.handles).toHaveLength(1)
  h.global(false)
  await h.flush()
  expect(h.handles[0]).toHaveBeenCalledOnce()
  h.project(true)
  await h.flush()
  expect(h.handles).toHaveLength(2)
  h.project(false)
  await h.flush()
  expect(h.handles[1]).toHaveBeenCalledOnce()
})

it.each([10, 100])(
  'coalesces reevaluation during awaited preparation without dropping %i spaced activity transitions',
  async (count) => {
    const h = installation(count)
    await h.flush()
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    h.prepare.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { agent: 'codex', surface: 'chat', target: { kind: 'existing', worktree: 'id:w0' } }
    })
    let sql = 0
    let rows = 0
    const histories = new Set<string>()
    const prepare = h.db.prepare.bind(h.db)
    vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      return new Proxy(statement, {
        get(owner, field) {
          if (field !== 'all' && field !== 'get' && field !== 'run') {
            return Reflect.get(owner, field)
          }
          return (...args: Database.BindValue[]) => {
            sql++
            for (const arg of args) {
              if (typeof arg === 'string' && /^pr[0-9]+$/.test(arg)) {
                histories.add(arg)
              }
            }
            const result = statement[field](...args)
            if (field !== 'run') {
              rows += Array.isArray(result) ? result.length : result ? 1 : 0
            }
            return result
          }
        }
      })
    })
    vi.mocked(recoverFollowUpLaunch).mockClear()
    const reconcile = vi.spyOn(h.engine, 'reconcile')
    const live = vi.mocked(h.inputs.live)
    live.mockClear()
    h.observe(['unit'])
    await preparing
    for (let index = 0; index < count; index++) {
      h.status(index % 2 === 0, h.now + index + 10)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(reconcile.mock.calls.filter(([keys]) => keys && [...keys].length).length).toBe(1)
    release()
    await h.flush()
    const jobs = reconcile.mock.calls.filter(([keys]) => keys && [...keys].length)
    expect(jobs.length).toBeLessThanOrEqual(2)
    expect(jobs.every(([keys]) => [...keys!].every((key) => key === 'pr0'))).toBe(true)
    expect(live.mock.calls.length).toBeLessThanOrEqual(6)
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(launchFollowUp).toHaveBeenCalledOnce()
    expect(recoverFollowUpLaunch).toHaveBeenCalledTimes(3)
    expect([...histories]).toEqual(['pr0'])
    expect(sql).toBeLessThan(count * 20 + 100)
    expect(rows).toBeLessThan(count * 20 + 100)
    const intervals = h.records.action('active-pr0')!.workingIntervals!
    expect(intervals).toHaveLength(count / 2)
    expect(intervals.slice(0, 2)).toEqual([
      { start: h.now - 100, end: h.now + 11 },
      { start: h.now + 12, end: h.now + 13 }
    ])
    expect(intervals.at(-1)?.end).toBe(h.now + count + 9)
  }
)

it('reconciles both old and new bindings while retaining unrelated reader handles', async () => {
  const h = installation(10)
  await h.flush()
  const reconcile = vi.spyOn(h.engine, 'reconcile')
  h.relink()
  await h.flush()
  expect(h.handles[0]).toHaveBeenCalledOnce()
  expect(h.handles.slice(1, 10).every((release) => release.mock.calls.length === 0)).toBe(true)
  expect(h.handles).toHaveLength(11)
  const launchInputs = vi.spyOn(h.inputs, 'launchInputs')
  const targetChanged = vi.spyOn(h.engine, 'targetChanged')
  h.unchanged()
  await h.flush()
  expect(launchInputs).not.toHaveBeenCalled()
  expect(targetChanged).not.toHaveBeenCalled()
  const keys = reconcile.mock.calls.flatMap(([keys]) => (keys ? [...keys] : []))
  expect([...new Set(keys)].sort()).toEqual(['new-pr', 'pr0'])
})
