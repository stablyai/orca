import { afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import { FollowUpEngine, type FollowUpEngineDependencies } from './engine'
import { FollowUpStore } from './store'
import Database from '../sqlite/sync-database'

class FakeObservations implements FollowUpObservationSource {
  registerPRWatch(): { unregister(): void } {
    return { unregister() {} }
  }
  observations = new Map<string, FollowUpObservation>()
  pushes: NonNullable<ReturnType<NonNullable<FollowUpObservationSource['pullRequestActionsFor']>>> =
    []
  subscribePRObservations(): () => void {
    return () => undefined
  }
  latest(key: string): FollowUpObservation | undefined {
    return this.observations.get(key)
  }
  pullRequestActionsFor(): typeof this.pushes {
    return this.pushes
  }
}
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.useRealTimers()
})

export function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'pr-followups-pr1-'))
  const path = join(folder, 'host.db')
  let db = new Database(path)
  let store = new FollowUpStore(db)
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
  const controls = {
    working: 'unknown' as boolean | 'unknown',
    live: 'unknown' as boolean | 'unknown',
    key: 'codex:chat',
    agent: 'codex',
    recipeInvalid: false,
    complete: false,
    liveIds: undefined as Set<string> | undefined,
    targets: undefined as FollowUpTarget[] | undefined
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
    targets: () => controls.targets ?? [target],
    workspaceIds: () => (controls.targets ?? [target]).map((item) => item.worktreeId),
    liveInstanceIds: () => controls.liveIds ?? new Set([target.instanceId]),
    inventoryComplete: () => controls.complete,
    recipe: () => {
      if (controls.recipeInvalid) {
        throw new Error('Invalid recipe')
      }
      return { agent: controls.agent, surface: 'chat' }
    },
    canPublishAgentLaunchTab: () => true,
    launchInputs: () => ({ key: controls.key, agent: controls.agent }),
    working: () => controls.working,
    launch,
    recover,
    prepare,
    live: async () => controls.live,
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
      mergeable: 'MERGEABLE',
      checksFinal: true,
      failingCheckNames: names,
      readComplete: true,
      observedAt: now,
      ...patch
    }
    source.observations.set(target.prKey, observation)
    await engine.observe(observation)
  }
  cleanups.push(async () => {
    await engine.dispose()
    store.close()
    rmSync(folder, { recursive: true, force: true })
  })
  return {
    source,
    target,
    controls,
    get now() {
      return now
    },
    launch,
    prepare,
    recover,
    global,
    observe,
    get engine() {
      return engine
    },
    get db() {
      return db
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
      db = new Database(path)
      store = new FollowUpStore(db)
      engine = new FollowUpEngine(deps())
      await engine.start()
    }
  }
}
