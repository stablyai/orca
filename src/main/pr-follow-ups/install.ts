import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type {
  FollowUpObservationSource,
  FollowUpHostInputs,
  FollowUpWorkspace
} from '../../shared/pr-follow-ups/contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'
import { FollowUpEngine } from './engine'
import { FollowUpStore } from './store'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'

export type { FollowUpHostInputs } from '../../shared/pr-follow-ups/contracts'
import { followUpChatActivity } from './action-lifecycle'

export function installPrFollowUps(
  runtime: OrcaRuntimeService,
  store: RuntimeStore,
  source: FollowUpObservationSource,
  inputs: FollowUpHostInputs,
  onGraphSync: (listener: () => void) => () => void,
  emit: (event: RuntimeClientEvent) => void
): { engine: FollowUpEngine; dispose(): Promise<void> } {
  let workspaces = inputs.workspaces()
  let workspaceByInstance = new Map(workspaces.map((item) => [item.instanceId, item]))
  const records = new FollowUpStore(runtime.getOrchestrationDb().db)
  const engine = new FollowUpEngine({
    ...inputs,
    started: (action) => {
      inputs.started?.(action)
      emit({
        type: 'prFollowUpStarted',
        prNumber: workspaceByInstance.get(action.instanceId)?.prNumber ?? undefined,
        failedCheckCount: action.failingNames.length,
        worktreeId: action.worktreeId,
        paneKey: action.paneKey,
        surface: action.surface,
        agent: action.agent
      })
    },
    source,
    workspaceIds: () => workspaces.map((workspace) => workspace.worktreeId),
    store: records,
    globalSettings: () => store.getSettings().prFollowUps,
    canPublishAgentLaunchTab: () => runtime.canPublishAgentLaunchTab(),
    launch: (params) => launchFollowUp(runtime, params),
    recover: (action) => recoverFollowUpLaunch(runtime, action),
    changed: (keys) => {
      syncWatches(keys)
      emit({ type: 'prFollowUpsChanged' })
    }
  })
  let disposed = false
  const registrations = new Map<string, { fingerprint: string; unregister(): void }>()
  let workspacesByPr = new Map<string, FollowUpWorkspace[]>()
  const indexWatches = (): void => {
    workspacesByPr = new Map()
    const targets = new Map(inputs.targets().map((target) => [target.instanceId, target]))
    for (const workspace of workspaces) {
      const key = targets.get(workspace.instanceId)?.prKey ?? ''
      const items = workspacesByPr.get(key) ?? []
      items.push(workspace)
      workspacesByPr.set(key, items)
    }
  }
  const releaseWatch = (instanceId: string): void => {
    registrations.get(instanceId)?.unregister()
    registrations.delete(instanceId)
  }
  const syncWatches = (keys: readonly string[] = [...workspacesByPr.keys()]): void => {
    if (disposed) {
      return
    }
    for (const prKey of keys) {
      const pr = prKey ? records.pr(prKey) : undefined
      const paused = pr && (pr.stoppedAt !== null || pr.consecutiveReadFailures >= 8)
      for (const workspace of workspacesByPr.get(prKey) ?? []) {
        const settings = resolvePrFollowUps(store.getSettings().prFollowUps, workspace.settings)
        const { repoId, connectionId, branch, prNumber } = workspace
        const key =
          !workspace.archived &&
          !paused &&
          branch &&
          settings.enabled &&
          settings.ciFailed !== 'off'
            ? JSON.stringify([repoId, connectionId, branch, prNumber])
            : undefined
        if (registrations.get(workspace.instanceId)?.fingerprint === key) {
          continue
        }
        releaseWatch(workspace.instanceId)
        if (!key) {
          continue
        }
        registrations.set(workspace.instanceId, {
          fingerprint: key,
          ...source.registerPRWatch({
            repoId,
            connectionId,
            branch,
            prNumber,
            reason: 'pr-follow-ups'
          })
        })
      }
    }
  }
  indexWatches()
  const pending = new Set<string>()
  let scheduled = false
  const schedule = (keys: Iterable<string>, inventory = false): void => {
    for (const key of keys) {
      pending.add(key)
    }
    if (scheduled || (!pending.size && !inventory) || disposed) {
      return
    }
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const keys = [...pending]
      pending.clear()
      void engine
        .reconcile(keys)
        .catch((error: unknown) => console.error('[pr-follow-ups] reconciliation failed', error))
    })
  }
  let workspaceKey = JSON.stringify(workspaces)
  const inventoryChanged = (): void => {
    const nextWorkspaces = inputs.workspaces()
    const nextKey = JSON.stringify(nextWorkspaces)
    workspaces = nextWorkspaces
    const affected = engine.refreshInventory()
    for (const target of inputs.targets()) {
      const value = JSON.stringify(inputs.launchInputs(target))
      if (launchKeys.get(target.instanceId) !== value) {
        affected.add(target.prKey)
      }
      launchKeys.set(target.instanceId, value)
    }
    if (workspaceKey === nextKey && !affected.size) {
      return
    }
    workspaceKey = nextKey
    workspaceByInstance = new Map(workspaces.map((item) => [item.instanceId, item]))
    const instances = new Set(workspaces.map((item) => item.instanceId))
    for (const id of registrations.keys()) {
      if (!instances.has(id)) {
        releaseWatch(id)
      }
    }
    indexWatches()
    schedule(affected, true)
    syncWatches()
  }
  const targetChanged = (worktreeId: string, activity = false): void => {
    const target = inputs.target(worktreeId)
    if (target) {
      schedule([...engine.targetChanged(target), ...(activity ? [target.prKey] : [])])
    }
  }
  const chatActivity = followUpChatActivity(engine, (id) => targetChanged(id, true))
  const launchKeys = new Map(
    inputs
      .targets()
      .map((target) => [target.instanceId, JSON.stringify(inputs.launchInputs(target))])
  )
  let settingsKey = JSON.stringify(store.getSettings().prFollowUps)
  const paneStates = new Map<string, string>()
  let inventoryWasComplete = inputs.inventoryComplete()
  const releases = [
    inputs.subscribeInventory((change) => {
      inventoryChanged()
      if (change.deletedInstanceId) {
        void engine.instanceDeleted(change.deletedInstanceId)
      }
      // Completeness may arrive after the last target change.
      if (!inventoryWasComplete && inputs.inventoryComplete()) {
        void engine.reconcile([])
      }
      inventoryWasComplete = inputs.inventoryComplete()
    }),
    onGraphSync(() => {
      if (engine.waitingForWindow && runtime.canPublishAgentLaunchTab()) {
        schedule(inputs.targets().map((target) => target.prKey))
      }
    }),
    runtime.onWorktreeLifecycle((event) => targetChanged(event.worktreeId)),
    runtime.agentTransitions.subscribe((change) => {
      if (change.kind === 'observed' || !change.workspace) {
        return
      }
      const phase = change.kind === 'moved' ? change.to : change.phase
      const state = JSON.stringify([change.workspace.worktreeId, phase])
      if (paneStates.get(change.paneKey) === state) {
        return
      }
      paneStates.set(change.paneKey, state)
      void engine.activityObserved(
        change.workspace.worktreeId,
        change.paneKey,
        phase === 'rest' ? 'unknown' : phase === 'working' || phase === 'needs-you',
        change.at
      )
      targetChanged(change.workspace.worktreeId, true)
    }),
    sessionCrewChanges.subscribe((facets) => {
      if (facets.has('topology')) {
        chatActivity.refresh()
        inventoryChanged()
      }
      if (facets.has('records') || facets.has('topology')) {
        schedule(engine.activePrKeys())
      }
    }),
    runtime.onClientEvent(
      (event) => {
        if (
          event.type === 'reposChanged' ||
          (event.type === 'worktreesChanged' && !event.sortOrderOnly)
        ) {
          inventoryChanged()
        }
      },
      { consumesTerminalSideEffects: false }
    ),
    store.onSettingsChanged?.((updates) => {
      if (
        !['prFollowUps', 'sourceControlAi', 'defaultTuiAgent', 'nativeChatProviders'].some(
          (key) => key in updates
        )
      ) {
        return
      }
      const key = JSON.stringify(store.getSettings().prFollowUps)
      const affected = engine.refreshInventory()
      if (settingsKey !== key) {
        for (const target of inputs.targets()) {
          affected.add(target.prKey)
        }
      }
      settingsKey = key
      // Effective input changes, rather than unrelated writes, wake parked attempts.
      for (const target of inputs.targets()) {
        const value = JSON.stringify(inputs.launchInputs(target))
        if (launchKeys.get(target.instanceId) !== value) {
          affected.add(target.prKey)
        }
        launchKeys.set(target.instanceId, value)
      }
      schedule(affected)
      if (affected.size) {
        syncWatches([...affected])
      }
    })
  ]
  void engine
    .start()
    .catch((error: unknown) => console.error('[pr-follow-ups] startup failed', error))
  syncWatches()
  return {
    engine,
    async dispose() {
      disposed = true
      for (const release of releases) {
        if (typeof release === 'function') {
          release()
        }
      }
      for (const registration of registrations.values()) {
        registration.unregister()
      }
      registrations.clear()
      chatActivity.dispose()
      await engine.dispose()
    }
  }
}
