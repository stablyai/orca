import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type {
  FollowUpObservationSource,
  FollowUpWorkspace
} from '../../shared/pr-follow-ups/contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'
import { FollowUpEngine, type FollowUpEngineDependencies } from './engine'
import { FollowUpStore } from './store'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'

// The selected reader supplies its workspace bindings and check-log read; it owns all GitHub reads.
export type FollowUpHostInputs = Pick<
  FollowUpEngineDependencies,
  'targets' | 'liveInstanceIds' | 'recipe' | 'prepare' | 'live' | 'working' | 'started'
> & { workspaces(): readonly FollowUpWorkspace[] }

export function installPrFollowUps(
  runtime: OrcaRuntimeService,
  store: RuntimeStore,
  source: FollowUpObservationSource,
  inputs: FollowUpHostInputs,
  onGraphSync: (listener: () => void) => () => void,
  emit: (event: RuntimeClientEvent) => void
): { engine: FollowUpEngine; dispose(): Promise<void> } {
  const records = new FollowUpStore(runtime.getOrchestrationDb().db)
  const engine = new FollowUpEngine({
    ...inputs,
    started: (action) => {
      inputs.started?.(action)
      emit({
        type: 'prFollowUpStarted',
        worktreeId: action.worktreeId,
        paneKey: action.paneKey,
        surface: action.surface,
        agent: action.launch.agent
      })
    },
    source,
    store: records,
    globalSettings: () => store.getSettings().prFollowUps,
    canPublishAgentLaunchTab: () => runtime.canPublishAgentLaunchTab(),
    launch: (params) => launchFollowUp(runtime, params),
    recover: (action) => recoverFollowUpLaunch(runtime, action),
    changed: () => emit({ type: 'prFollowUpsChanged' })
  })
  let disposed = false
  const watches = new Map<string, () => void>()
  const syncWatches = (): void => {
    if (disposed) {
      return
    }
    const wanted = new Set<string>()
    for (const workspace of inputs.workspaces()) {
      const settings = resolvePrFollowUps(store.getSettings().prFollowUps, workspace.settings)
      const target = inputs.targets().find((item) => item.instanceId === workspace.instanceId)
      const pr = target ? records.pr(target.prKey) : undefined
      const paused =
        pr &&
        (pr.stoppedAt !== null ||
          pr.consecutiveReadFailures >= 8 ||
          pr.consecutiveCommentWakes >= 10)
      if (
        workspace.archived ||
        paused ||
        !workspace.branch ||
        !settings.enabled ||
        settings.ciFailed === 'off'
      ) {
        continue
      }
      const { repoPath, connectionId, branch, prNumber } = workspace
      const key = JSON.stringify([repoPath, connectionId, branch, prNumber])
      wanted.add(key)
      if (!watches.has(key)) {
        watches.set(
          key,
          source.watchWorkspace({
            repoPath,
            connectionId,
            branch,
            prNumber,
            reason: 'pr-follow-ups'
          })
        )
      }
    }
    for (const [key, release] of watches) {
      if (!wanted.has(key)) {
        release()
        watches.delete(key)
      }
    }
  }
  let scheduled = false
  let again = false
  const reconcile = (): void => {
    if (disposed) {
      return
    }
    if (scheduled) {
      again = true
      return
    }
    scheduled = true
    queueMicrotask(() => {
      syncWatches()
      void engine
        .reconcile()
        .catch((error: unknown) => console.error('[pr-follow-ups] reconciliation failed', error))
        .finally(() => {
          scheduled = false
          if (again) {
            again = false
            reconcile()
          }
        })
    })
  }
  const releases = [
    onGraphSync(() => {
      if (engine.waitingForWindow && runtime.canPublishAgentLaunchTab()) {
        reconcile()
      }
    }),
    runtime.onWorktreeLifecycle(reconcile),
    runtime.agentTransitions.subscribe(reconcile),
    sessionCrewChanges.subscribe(reconcile),
    runtime.onClientEvent(
      (event) => {
        if (event.type === 'prFollowUpsChanged') {
          syncWatches()
        }
        if (event.type === 'reposChanged' || event.type === 'worktreesChanged') {
          reconcile()
        }
      },
      { consumesTerminalSideEffects: false }
    ),
    store.onStateWritten?.(reconcile),
    store.onSettingsChanged?.(reconcile)
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
      for (const release of watches.values()) {
        release()
      }
      watches.clear()
      await engine.dispose()
    }
  }
}
