import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type {
  FollowUpObservationSource,
  FollowUpHostInputs
} from '../../shared/pr-follow-ups/contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'
import { FollowUpEngine } from './engine'
import { FollowUpStore } from './store'
import { FollowUpInventory } from './inventory'
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
  let inventory: FollowUpInventory
  const records = new FollowUpStore(runtime.getOrchestrationDb().db)
  const engine = new FollowUpEngine({
    ...inputs,
    started: (action) => {
      inputs.started?.(action)
      emit({
        type: 'prFollowUpStarted',
        prNumber: inventory.byInstance.get(action.instanceId)?.prNumber ?? undefined,
        failedCheckCount: action.failingNames.length,
        worktreeId: action.worktreeId,
        paneKey: action.paneKey,
        surface: action.surface,
        agent: action.agent
      })
    },
    source,
    workspaceIds: () => inputs.workspaces().map((workspace) => workspace.worktreeId),
    store: records,
    globalSettings: () => store.getSettings().prFollowUps,
    canPublishAgentLaunchTab: () => runtime.canPublishAgentLaunchTab(),
    launch: (params) => launchFollowUp(runtime, params),
    recover: (action) => recoverFollowUpLaunch(runtime, action),
    changed: (keys) => {
      if (!disposed) {
        inventory.sync(keys)
      }
      emit({ type: 'prFollowUpsChanged' })
    }
  })
  let disposed = false
  inventory = new FollowUpInventory(
    inputs,
    source,
    records,
    engine,
    () => store.getSettings().prFollowUps
  )
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
      const keys = [...pending]
      pending.clear()
      void engine
        .reconcile(keys)
        .catch((error: unknown) => console.error('[pr-follow-ups] reconciliation failed', error))
        .finally(() => {
          scheduled = false
          schedule([])
        })
    })
  }
  const inventoryChanged = (repoId?: string): void => {
    const affected = inventory.refresh(repoId)
    if (affected.size) {
      schedule([...affected].filter(Boolean), true)
      inventory.sync([...affected])
    }
  }
  const targetChanged = (worktreeId: string): void => {
    const target = inputs.target(worktreeId)
    if (target) {
      schedule(engine.targetChanged(target))
    }
  }
  const chatActivity = followUpChatActivity(engine, (id, keys) => {
    if (keys) {
      schedule(keys)
    }
    targetChanged(id)
  })
  let settingsKey = JSON.stringify(store.getSettings().prFollowUps)
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
      const activity = engine.activityObserved(
        change.workspace.worktreeId,
        change.paneKey,
        phase === 'rest' ? 'unknown' : phase === 'working' || phase === 'needs-you',
        change.at
      )
      if (activity) {
        schedule(activity)
      }
      targetChanged(change.workspace.worktreeId)
    }),
    sessionCrewChanges.subscribe((facets) => {
      if (facets.has('topology')) {
        chatActivity.refresh()
        inventoryChanged()
      }
      if (facets.has('topology')) {
        // Topology recovery deliberately checks obligations that outlive their workspace.
        schedule(engine.activePrKeys())
      } else if (facets.has('records') || facets.operationIds?.length) {
        schedule(
          facets.recordIds || facets.recordWorkspaceIds || facets.operationIds
            ? engine.prKeysForAuthorities(
                facets.recordIds ?? [],
                [],
                facets.operationIds ?? [],
                facets.recordWorkspaceIds ?? []
              )
            : engine.activePrKeys()
        )
      }
    }),
    runtime.onClientEvent(
      (event) => {
        if (event.type === 'reposChanged') {
          inventoryChanged()
          const affected = inventory.effectiveInputsChanged()
          schedule(affected)
          inventory.sync()
        } else if (event.type === 'worktreesChanged' && !event.sortOrderOnly) {
          inventoryChanged(event.repoId)
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
      const affected = inventory.refresh()
      if (settingsKey !== key) {
        for (const target of inputs.targets()) {
          affected.add(target.prKey)
        }
      }
      settingsKey = key
      for (const key of inventory.effectiveInputsChanged()) {
        affected.add(key)
      }
      schedule([...affected].filter(Boolean))
      // Discovery also belongs to unresolved workspaces, which have no PR key yet.
      inventory.sync()
    })
  ]
  void engine
    .start()
    .catch((error: unknown) => console.error('[pr-follow-ups] startup failed', error))
  inventory.sync()
  return {
    engine,
    async dispose() {
      disposed = true
      for (const release of releases) {
        if (typeof release === 'function') {
          release()
        }
      }
      inventory.dispose()
      chatActivity.dispose()
      await engine.dispose()
    }
  }
}
