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
import { activityOverlaps } from './activity-journal'
import { FollowUpStore } from './store'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionStatusEvent } from '../../shared/agent-session/agent-session-wire'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'

vi.mock('./launch', () => ({
  launchFollowUp: vi.fn(),
  recoverFollowUpLaunch: vi.fn().mockResolvedValue({ status: 'unconfirmed' })
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: vi.fn()
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

function installation(
  count: number,
  unresolved = false,
  surface: 'chat' | 'terminal' = 'terminal',
  initial = false
) {
  vi.mocked(recoverFollowUpLaunch).mockResolvedValue({ status: 'unconfirmed' })
  const db = new Database(':memory:')
  const records = new FollowUpStore(db)
  const now = Date.now()
  let enabled = !unresolved
  let working: { working: boolean; at: number } | 'unknown' = 'unknown'
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
      surface,
      ...(surface === 'terminal'
        ? { paneKey: `pane-${target.worktreeId}` }
        : { sessionId: `pane-${target.worktreeId}` }),
      sessionStartedAt: now - 100
    })
  }
  if (targets[0]) {
    records.saveAction({
      ...records.action('active-pr0')!,
      actionKey: 'uncertain-pr0',
      operationId: 'uncertain-op-pr0',
      status: 'unconfirmed',
      paneKey: undefined,
      sessionId: undefined,
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
    working: (action) =>
      [action.paneKey, action.sessionId].includes('pane-w0') ? working : 'unknown',
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
  let chatEmit: ((event: AgentSessionStatusEvent) => void) | undefined
  const chatSession = (identity: string, active: boolean, at: number, workspaceId = 'w0') => ({
    sessionId: identity,
    workspaceId,
    agent: 'codex',
    status: active ? ('working' as const) : ('idle' as const),
    latestPrompt: '',
    updatedAt: at,
    statusStartedAt: at
  })
  vi.mocked(getStructuredAgentSessionHost).mockReturnValue(
    surface === 'chat'
      ? ({
          subscribeStatus: (sink: { emit(event: AgentSessionStatusEvent): void }) => {
            chatEmit = sink.emit
            if (initial) {
              sink.emit({ type: 'snapshot', sessions: [chatSession('pane-w0', false, now + 10)] })
            }
            return () => {}
          }
        } as unknown as NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>)
      : null
  )
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
          if (initial) {
            listener({
              kind: 'seeded',
              workspace: { worktreeId: 'w0', sshHostId: null },
              paneKey: 'pane-w0',
              phase: 'done',
              at: now + 10
            })
          }
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
    status: (active: boolean, at: number) => {
      working = { working: active, at }
      targets[0] = { ...targets[0]!, workingAgent: active ? 'Codex' : null }
      if (surface === 'chat') {
        chatEmit?.({ type: 'status', session: chatSession('pane-w0', active, at) })
      } else {
        transition({
          kind: 'moved',
          workspace: { worktreeId: 'w0', sshHostId: null },
          paneKey: 'pane-w0',
          from: active ? 'done' : 'working',
          to: active ? 'working' : 'done',
          transition: null,
          at
        })
      }
    },
    global: (value: boolean) => {
      enabled = value
      settings({ prFollowUps: { enabled } })
    },
    project: (value: boolean) => {
      workspaces = workspaces.map((item) => ({ ...item, settings: { enabled: value } }))
      clientEvent({ type: 'reposChanged' })
    },
    stream: (identity: string, active: boolean, at: number, workspaceId = 'w0') => {
      if (surface === 'chat') {
        chatEmit?.({ type: 'status', session: chatSession(identity, active, at, workspaceId) })
      } else {
        transition({
          kind: 'moved',
          workspace: { worktreeId: workspaceId, sshHostId: null },
          paneKey: identity,
          from: active ? 'done' : 'working',
          to: active ? 'working' : 'done',
          transition: null,
          at
        })
      }
    },
    inventory: (nextTargets: FollowUpTarget[], nextWorkspaces: FollowUpWorkspace[]) => {
      targets = nextTargets
      workspaces = nextWorkspaces
      inventory({})
    },
    get targets() {
      return targets
    },
    get workspaces() {
      return workspaces
    },
    nextObservation: (head: string, at: number) => {
      const next = {
        ...observations.get('pr0')!,
        headSha: head,
        observedAt: at,
        failingCheckNames: []
      }
      observations.set('pr0', next)
      observation(next)
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
    const evidence = h.records.activityWindow('i0', 'pane-w0', h.now, h.now + count + 10)
    expect(
      new Set(evidence.filter((event) => event.kind === 'idle').map((event) => event.at)).size
    ).toBe(count / 2)
    expect(activityOverlaps(evidence, h.now + 11.5, h.now + 11.9)).toBe(false)
    expect(h.records.workingOverlap('pr0', h.now + 12, h.now + 13)).toBe(true)
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

it.each(['chat', 'terminal'] as const)(
  'admits the synchronous initial %s snapshot before any projection',
  async (surface) => {
    const h = installation(1, false, surface, true)
    expect(h.records.workingOverlap('pr0', h.now + 11, h.now + 12)).toBe(false)
    h.stream('pane-w0', true, h.now + 20)
    await h.flush()
    h.nextObservation('h2', h.now + 25)
    await h.flush()
    expect(h.records.pr('pr0')?.generation).toBe(0)
  }
)

it.each(['chat', 'terminal'] as const)(
  'recovers late %s identity through an ordinary record commit without losing another session’s idle gap',
  async (surface) => {
    const h = installation(1, false, surface)
    await h.flush()
    let entered!: () => void
    let settle!: () => void
    const launching = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.mocked(launchFollowUp).mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        settle = resolve
      })
      return { status: 'unconfirmed' }
    })
    h.observe(['unit'])
    await launching
    const action = h.records.latestAction('pr0')!
    const at = Date.now() + 1000
    // Both identities arrive while the operation is claimed, before any receipt identifies it.
    h.stream('pane-w0', false, at + 1)
    h.stream('late', true, at + 5)
    h.stream('other', false, at + 8)
    h.stream('late', false, at + 10)
    h.stream('late', true, at + 20)
    h.stream('other', false, at + 25)
    settle()
    await h.flush()
    vi.mocked(recoverFollowUpLaunch).mockImplementation(async (_runtime, candidate) =>
      candidate.operationId === action.operationId
        ? {
            status: 'accepted',
            identity:
              surface === 'chat' ? { surface, sessionId: 'late' } : { surface, paneKey: 'late' }
          }
        : { status: 'unconfirmed' }
    )
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordIds: ['late'],
        recordWorkspaceIds: ['w0'],
        operationIds: [action.operationId]
      })
    )
    await h.flush()
    expect(h.records.action(action.actionKey)?.status).toBe('accepted')
    expect(h.records.workingOverlap('pr0', at + 15, at + 18)).toBe(false)
    expect(h.records.workingOverlap('pr0', at + 21, at + 28)).toBe(true)
    expect(launchFollowUp).toHaveBeenCalledOnce()
  }
)

it.each([
  ['chat', 10],
  ['chat', 100],
  ['terminal', 10],
  ['terminal', 100]
] as const)(
  'bounds admission and fixed-window reads through the %s adapter with %i historical transitions',
  async (surface, count) => {
    const h = installation(count, false, surface)
    await h.flush()
    let rows = 0
    let actionWrites = 0
    let sql = 0
    const prepare = h.db.prepare.bind(h.db)
    vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      return new Proxy(statement, {
        get(owner, field) {
          if (!['get', 'all', 'run'].includes(String(field))) {
            return Reflect.get(owner, field)
          }
          return (...args: Database.BindValue[]) => {
            sql++
            if (/INSERT INTO followup_action/.test(query)) {
              actionWrites++
            }
            const result = statement[field as 'all'](...args)
            if (field !== 'run') {
              rows += Array.isArray(result) ? result.length : result ? 1 : 0
            }
            return result
          }
        }
      })
    })
    // Ordinary unrelated stream and committed-record events must not load any obligation history.
    h.stream('unrelated', true, h.now, 'other-workspace')
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordIds: ['unrelated'],
        recordWorkspaceIds: ['other-workspace']
      })
    )
    await h.flush()
    expect(sql).toBe(0)
    for (let i = 0; i < count; i++) {
      h.stream('pane-w0', i % 2 === 0, h.now - 90 + i / 4)
    }
    // The append path has no reads or action rewrites, regardless of retained history.
    expect(rows).toBe(0)
    expect(actionWrites).toBe(0)
    expect(sql).toBe(count)
    await h.flush()
    h.stream('pane-w0', true, h.now + 10)
    h.stream('pane-w0', false, h.now + 20)
    rows = 0
    expect(h.records.workingOverlap('pr0', h.now + 11, h.now + 15)).toBe(true)
    expect(rows).toBeLessThanOrEqual(3)
    rows = 0
    expect(h.records.workingOverlap('pr0', h.now + 21, h.now + 25)).toBe(false)
    expect(rows).toBeLessThanOrEqual(3)
    // A shared PR binding retains its evidence when one instance is deleted.
    h.records.bind('pr0', 'shared-instance')
    await h.engine.instanceDeleted('i0')
    expect(h.records.workingOverlap('pr0', h.now + 11, h.now + 15)).toBe(true)
  }
)

it.each([10, 100])(
  'finalizes shared-PR inventory membership once for %i additions, removals and resolution losses',
  async (count) => {
    const h = installation(1)
    await h.flush()
    const added = Array.from({ length: count }, (_, i) => ({
      ...h.targets[0]!,
      worktreeId: `new-w${i}`,
      instanceId: `new-i${i}`
    }))
    const spaces = added.map((t) => ({
      ...h.workspaces[0]!,
      worktreeId: t.worktreeId,
      instanceId: t.instanceId
    }))
    const stringify = JSON.stringify.bind(JSON)
    let keys = 0
    let groups = 0
    const originalIterator = Array.prototype[Symbol.iterator]
    // Count actual serialized membership keys and shared-group traversals at listener admission.
    const jsonSpy = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (
        Array.isArray(value) &&
        value.every((v) => typeof v === 'string' && /^(new-w|w)/.test(v))
      ) {
        keys += value.length
      }
      return stringify(value, ...args)
    })
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      if (this.length && this[0] && typeof this[0] === 'object' && 'prKey' in this[0]) {
        groups += this.length
      }
      return originalIterator.call(this)
    }
    const measure = (targets: FollowUpTarget[], workspaces: FollowUpWorkspace[]) => {
      keys = 0
      groups = 0
      h.inventory(targets, workspaces)
      expect(keys).toBeLessThanOrEqual((count + 1) * 2)
      expect(groups).toBeLessThanOrEqual((count + 1) * 12)
    }
    try {
      measure([...h.targets, ...added], [...h.workspaces, ...spaces])
      await h.flush()
      measure(h.targets.slice(0, 1), h.workspaces)
      await h.flush()
      measure([h.targets[0]!, ...added], h.workspaces)
      await h.flush()
      measure(h.targets.slice(0, 1), h.workspaces.slice(0, 1))
    } finally {
      jsonSpy.mockRestore()
      Array.prototype[Symbol.iterator] = originalIterator
    }
    await h.flush()
  }
)
