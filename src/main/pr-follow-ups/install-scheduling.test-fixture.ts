import { afterEach, vi, type Mock } from 'vitest'
import Database from '../sqlite/sync-database'
import type {
  FollowUpAction,
  FollowUpHostInputs,
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget,
  FollowUpWorkspace
} from '../../shared/pr-follow-ups/contracts'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { installPrFollowUps } from './install'
import { installationActivity } from './install-activity.test-fixture'
import { FollowUpStore } from './store'
import type { FollowUpEngineDependencies } from './engine-contract'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'

vi.mock('./launch', () => ({
  launchFollowUp: vi.fn(),
  recoverFollowUpLaunch: vi.fn().mockResolvedValue({ status: 'unconfirmed' })
}))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: vi.fn()
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

export function installation(
  count: number,
  unresolved = false,
  surface: 'chat' | 'terminal' = 'terminal',
  initial = false,
  shared = false
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
  if (shared) {
    for (const action of records.pendingActions()) {
      records.saveAction({
        ...action,
        worktreeId: 'w0',
        instanceId: 'i0',
        ...(action.status === 'unconfirmed' ? { recoveryFinalizedAt: now } : {})
      })
    }
    targets = targets.slice(0, 1)
    workspaces = workspaces.slice(0, 1)
  }
  let inventory!: Parameters<FollowUpHostInputs['subscribeInventory']>[0]
  let settings!: (updates: Record<string, unknown>) => void
  let clientEvent!: (event: RuntimeClientEvent) => void
  let observation!: (event: FollowUpObservation) => void
  const handles: Mock<() => void>[] = []
  const prepare: Mock<FollowUpHostInputs['prepare']> = vi
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
      const unregister = vi.fn<() => void>()
      handles.push(unregister)
      return { unregister }
    },
    subscribePRObservations: (listener) => {
      observation = listener
      for (const value of observations.values()) {
        listener(value)
      }
      return () => {}
    }
  }
  vi.mocked(launchFollowUp)
    .mockClear()
    .mockResolvedValue({
      status: 'accepted',
      identity: { sessionId: 'new-agent', surface: 'chat' }
    })
  const activity = installationActivity(surface, now, initial)
  const boot = () =>
    installPrFollowUps(
      {
        getOrchestrationDb: () => ({ db }),
        canPublishAgentLaunchTab: () => true,
        onWorktreeLifecycle: () => () => {},
        onClientEvent: (listener: typeof clientEvent) => {
          clientEvent = listener
          return () => {}
        },
        agentTransitions: { subscribe: activity.subscribe }
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
  let host = boot()
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
    get engine() {
      return host.engine
    },
    restart: async () => {
      await host.dispose()
      host = boot()
      await flush()
    },
    records,
    commitAction: (action: FollowUpAction) => {
      const deps: FollowUpEngineDependencies = Reflect.get(host.engine, 'deps')
      deps.store.saveAction(action)
    },
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
      activity.stream('pane-w0', active, at)
    },
    global: (value: boolean) => {
      enabled = value
      settings({ prFollowUps: { enabled } })
    },
    project: (value: boolean) => {
      workspaces = workspaces.map((item) => ({ ...item, settings: { enabled: value } }))
      clientEvent({ type: 'reposChanged' })
    },
    stream: activity.stream,
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
