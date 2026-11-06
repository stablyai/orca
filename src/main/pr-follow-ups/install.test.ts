import { afterEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type {
  FollowUpHostInputs,
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget,
  FollowUpWorkspace
} from '../../shared/pr-follow-ups/contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'
import { installPrFollowUps } from './install'
import { FollowUpStore } from './store'
import { PR_FOLLOW_UP_METHODS } from '../runtime/rpc/methods/pr-follow-ups'
import { launchFollowUp } from './launch'

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

it.each([10, 100])(
  'scopes real installation listeners and cached get projections with %i persisted workspaces',
  async (count) => {
    const db = new Database(':memory:')
    const records = new FollowUpStore(db)
    const metrics = {
      inventoryVisits: 0,
      targetVisits: 0,
      rows: 0,
      sql: 0,
      promptBytes: 0,
      histories: new Set<string>()
    }
    const tracked = <T>(items: T[]): T[] =>
      new Proxy(items, {
        get(owner, field, receiver) {
          if (typeof field === 'string' && /^\d+$/.test(field)) {
            metrics.inventoryVisits++
          }
          return Reflect.get(owner, field, receiver)
        }
      })
    const targets = tracked(
      Array.from({ length: count }, (_, index): FollowUpTarget => {
        const value = {
          worktreeId: `w${index}`,
          instanceId: `i${index}`,
          prKey: `github.com/a/b#${Math.floor(index / 2)}`,
          branch: 'fix',
          lastActiveAt: index,
          archived: index % 5 === 0,
          settings: { enabled: index % 4 !== 0 },
          workingAgent: 'Codex' as string | null
        }
        return new Proxy(value, {
          get(owner, field, receiver) {
            metrics.targetVisits++
            return Reflect.get(owner, field, receiver)
          }
        })
      })
    )
    const byId = new Map(targets.map((target) => [target.worktreeId, target]))
    const workspaces = tracked(
      targets.map((target, index): FollowUpWorkspace => ({
        instanceId: target.instanceId,
        worktreeId: target.worktreeId,
        repoId: 'repo',
        connectionId: null,
        branch: 'fix',
        prNumber: Math.floor(index / 2),
        archived: target.archived,
        settings: target.settings
      }))
    )
    const observations = new Map<string, FollowUpObservation>()
    for (const target of targets) {
      const prKey = target.prKey
      if (observations.has(prKey)) {
        continue
      }
      observations.set(prKey, {
        prKey,
        headSha: 'h1',
        headRefName: 'fix',
        baseSha: 'base',
        state: 'open',
        mergeable: 'MERGEABLE',
        checksFinal: true,
        failingCheckNames: ['unit'],
        readComplete: true,
        observedAt: Date.now()
      })
      records.savePr({
        prKey,
        baselineAt: 1,
        needsBaseline: false,
        headSha: 'h1',
        lastSeenAt: 1,
        handled: [],
        baselineNames: [],
        generation: 0,
        stoppedAt: null,
        consecutiveReadFailures: 0,
        pendingRead: false,
        state: 'open'
      })
      records.bind(prKey, target.instanceId)
      const legacy = {
        actionKey: `old-${prKey}`,
        prKey,
        headSha: 'old',
        failingNames: ['old'],
        mode: 'new-agent' as const,
        worktreeId: target.worktreeId,
        instanceId: target.instanceId,
        generation: -1,
        attempt: 1,
        attemptStartedAt: 1,
        operationId: 'old-operation',
        status: 'accepted' as const,
        sessionStartedAt: 1,
        sessionEndedAt: 2,
        launch: {
          agent: 'codex',
          target: { kind: 'existing', worktree: `id:${target.worktreeId}` },
          prompt: { delivery: 'submit', text: 'irrelevant-install-prompt:'.repeat(4096) }
        }
      }
      db.prepare('INSERT INTO followup_action VALUES (?, ?, ?)').run(
        legacy.actionKey,
        legacy.prKey,
        JSON.stringify(legacy)
      )
    }
    let observationListener!: (observation: FollowUpObservation) => void
    let transition!: (change: AgentPaneChange) => void
    let clientEvent!: (event: RuntimeClientEvent) => void
    let settingsChanged!: (updates: Record<string, unknown>) => void
    let inventoryChanged!: Parameters<FollowUpHostInputs['subscribeInventory']>[0]
    const emitted: RuntimeClientEvent[] = []
    const runtime = {
      getOrchestrationDb: () => ({ db }),
      canPublishAgentLaunchTab: () => true,
      agentTransitions: {
        subscribe: (listener: typeof transition) => {
          transition = listener
          return () => {}
        }
      },
      onWorktreeLifecycle: () => () => {},
      onClientEvent: (listener: typeof clientEvent) => {
        clientEvent = listener
        return () => {}
      }
    } as unknown as OrcaRuntimeService
    const store = {
      getSettings: () => ({ prFollowUps: { enabled: true } }),
      onSettingsChanged: (listener: typeof settingsChanged) => {
        settingsChanged = listener
        return () => {}
      }
    } as unknown as RuntimeStore
    const registrations: { prNumber: number | null; unregister: ReturnType<typeof vi.fn> }[] = []
    const source: FollowUpObservationSource = {
      latest: (key) => observations.get(key),
      registerPRWatch: (watch) => {
        const registration = { prNumber: watch.prNumber, unregister: vi.fn() }
        registrations.push(registration)
        class Handle {
          unregister(): void {
            registration.unregister()
          }
        }
        return new Handle()
      },
      subscribePRObservations: (listener) => {
        observationListener = listener
        return () => {}
      }
    }
    const knownTargets = tracked(targets.slice(0, -1))
    const inputs: FollowUpHostInputs = {
      targets: () => knownTargets,
      target: (id) => byId.get(id),
      workspaces: () => workspaces,
      liveInstanceIds: () => new Set(targets.map((target) => target.instanceId)),
      inventoryComplete: () => true,
      subscribeInventory: (listener) => {
        inventoryChanged = listener
        return () => {}
      },
      recipe: () => ({ agent: 'codex', surface: 'chat' }),
      launchInputs: () => ({ key: 'codex:model1:available', agent: 'codex' }),
      working: () => 'unknown',
      live: async () => 'unknown',
      prepare: async (_observation, _names, target) => ({
        agent: 'codex',
        surface: 'chat',
        target: { kind: 'existing', worktree: `id:${target.worktreeId}` }
      })
    }
    vi.mocked(launchFollowUp).mockResolvedValue({
      status: 'accepted',
      identity: { surface: 'chat', sessionId: 'auto-session' }
    })
    const host = installPrFollowUps(
      runtime,
      store,
      source,
      inputs,
      () => () => {},
      (event) => emitted.push(event)
    )
    cleanups.push(async () => {
      await host.dispose()
      db.close()
    })
    const drain = async () => {
      await Promise.resolve()
      await host.engine.reconcile([])
    }
    await drain()
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (!sql.includes('followup_')) {
        return statement
      }
      return new Proxy(statement, {
        get(owner, field) {
          if (field !== 'get' && field !== 'all' && field !== 'run') {
            return Reflect.get(owner, field)
          }
          return (...args: Database.BindValue[]) => {
            metrics.sql++
            if (sql.includes('followup_action')) {
              for (const arg of args) {
                if (typeof arg === 'string' && observations.has(arg)) {
                  metrics.histories.add(arg)
                }
              }
            }
            const result = statement[field](...args)
            if (field !== 'run') {
              for (const row of Array.isArray(result) ? result : result ? [result] : []) {
                metrics.rows++
                for (const value of Object.values(row)) {
                  if (typeof value === 'string' && value.includes('irrelevant-install-prompt:')) {
                    metrics.promptBytes += value.length
                  }
                }
              }
            }
            return result
          }
        }
      })
    })
    const reset = () => {
      metrics.inventoryVisits = 0
      metrics.targetVisits = 0
      metrics.rows = 0
      metrics.sql = 0
      metrics.promptBytes = 0
      metrics.histories.clear()
      emitted.length = 0
    }
    reset()
    observationListener({
      ...observations.values().next().value!,
      prKey: 'github.com/other/unrelated#999'
    })
    settingsChanged({ fontSize: 14 })
    sessionCrewChanges.notify(new Set(['names']))
    clientEvent({ type: 'worktreesChanged', repoId: 'unrelated', sortOrderOnly: true })
    transition({
      kind: 'observed',
      workspace: { worktreeId: 'w3', sshHostId: null },
      paneKey: 'pane',
      phase: 'working',
      at: 10
    })
    await drain()
    expect({
      sql: metrics.sql,
      rows: metrics.rows,
      targetVisits: metrics.targetVisits,
      inventoryVisits: metrics.inventoryVisits,
      emitted: emitted.length
    }).toEqual({ sql: 0, rows: 0, targetVisits: 0, inventoryVisits: 0, emitted: 0 })
    const get = PR_FOLLOW_UP_METHODS.find((method) => method.name === 'prFollowUps.get')!
    const snapshot = await get.handler({}, { runtime: { prFollowUps: host.engine } } as never)
    expect(Object.keys(snapshot.workspaces)).toHaveLength(count)
    expect(snapshot.workspaces.w0?.view.state).toBe('off')
    expect(snapshot.workspaces.w4?.view.state).toBe('off')
    expect(snapshot.workspaces.w5?.view.state).toBe('off')
    expect(snapshot.workspaces[`w${count - 1}`]).toBeNull()
    expect(metrics.inventoryVisits).toBe(0)
    expect(metrics.targetVisits).toBe(0)
    expect(metrics.sql).toBe(0)
    byId.get('w3')!.workingAgent = null
    transition({
      kind: 'moved',
      workspace: { worktreeId: 'w3', sshHostId: null },
      paneKey: 'pane',
      from: 'working',
      to: 'done',
      transition: 'turn-finished',
      at: 20
    })
    await drain()
    expect([...metrics.histories]).toEqual(['github.com/a/b#1'])
    expect(metrics.rows).toBeLessThan(30)
    expect(metrics.inventoryVisits).toBe(0)
    expect(metrics.promptBytes).toBe(0)
    expect(emitted.filter((event) => event.type === 'prFollowUpsChanged')).toHaveLength(3)
    expect(
      (await get.handler({}, { runtime: { prFollowUps: host.engine } } as never)).workspaces.w3
        ?.view.state
    ).toBe('handled')
    reset()
    transition({
      kind: 'seeded',
      workspace: { worktreeId: 'w3', sshHostId: null },
      paneKey: 'pane',
      phase: 'done',
      at: 20
    })
    inventoryChanged({})
    await drain()
    expect(metrics.sql).toBe(0)
    expect(emitted).toHaveLength(0)
    // Each instance owns its reader handle even when request inputs match another instance.
    const pair = registrations.filter((item) => item.prNumber === 1)
    expect(pair).toHaveLength(2)
    byId.get('w2')!.settings = { enabled: false }
    workspaces[2]!.settings = { enabled: false }
    inventoryChanged({})
    await drain()
    expect(pair[0]!.unregister).toHaveBeenCalledOnce()
    expect(pair[1]!.unregister).not.toHaveBeenCalled()
    byId.get('w3')!.settings = { enabled: false }
    workspaces[3]!.settings = { enabled: false }
    inventoryChanged({})
    await drain()
    expect(pair[1]!.unregister).toHaveBeenCalledOnce()
  }
)
