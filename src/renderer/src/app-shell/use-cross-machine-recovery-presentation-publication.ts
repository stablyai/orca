import { useEffect } from 'react'
import { CROSS_MACHINE_RECOVERY_PRESENTATION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { RecoveryPresentationWorkspace } from '../../../shared/cross-machine-recovery-presentation-types'
import type { CrossMachineRecoveryPresentationApi } from '../../../preload/api/cross-machine-recovery-presentation-api'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import {
  createHumanInputActivityTracker,
  type HumanInputActivityTracker,
  type HumanInputScope
} from '../lib/human-input-activity'
import {
  activePresentationSessionKey,
  presentationPaneKey,
  projectCrossMachineRecoveryPresentation,
  type PresentationWorkspaceCatalog
} from '../lib/cross-machine-recovery-presentation-projection'
import {
  createCrossMachineRecoveryPresentationPublisher,
  type CrossMachineRecoveryPresentationPublisher,
  type PresentationPublishTransport
} from '../lib/cross-machine-recovery-presentation-publisher'
import {
  buildWorkspaceSessionPayload,
  SESSION_RELEVANT_FIELDS,
  shouldPersistWorkspaceSession
} from '../lib/workspace-session'
import { buildHostIdByWorktreeId } from '../lib/workspace-session-host-persistence'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '../runtime/runtime-rpc-client'

const PRESENTATION_PUBLISH_TIMEOUT_MS = 15_000

function presentationCatalog(state: AppState): PresentationWorkspaceCatalog {
  const worktrees = new Map(
    Object.values(state.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
  const folderPaths = new Map(
    state.folderWorkspaces.map((folder) => [`folder:${folder.id}`, folder.folderPath])
  )
  return {
    pathFor: (key) => folderPaths.get(key) ?? worktrees.get(key)?.path ?? null,
    instanceIdFor: (worktreeId) => worktrees.get(worktreeId)?.instanceId
  }
}

function inputScope(state: AppState): HumanInputScope {
  const leafId = state.activeTabId
    ? state.terminalLayoutsByTabId[state.activeTabId]?.activeLeafId
    : null
  return {
    workspaceKey: activePresentationSessionKey(state),
    paneKey: presentationPaneKey(state.activeTabId, leafId)
  }
}

function presentationSnapshot(
  tracker: HumanInputActivityTracker
): Map<ExecutionHostId, RecoveryPresentationWorkspace[]> {
  const state = useAppStore.getState()
  const byHost = projectCrossMachineRecoveryPresentation({
    session: buildWorkspaceSessionPayload(state),
    hostIdByWorktreeId: buildHostIdByWorktreeId(state),
    catalog: presentationCatalog(state),
    windowFocused: tracker.windowFocused(),
    inputFor: tracker.inputFor
  })
  return new Map([...byHost].map(([hostId, snapshot]) => [hostId, snapshot.workspaces]))
}

function presentationTransport(
  api: CrossMachineRecoveryPresentationApi
): PresentationPublishTransport {
  return {
    supportsHost: async (hostId) => {
      const host = parseExecutionHostId(hostId)
      if (host?.kind === 'local') {
        return api.publishLocal !== null
      }
      return host?.kind === 'runtime'
        ? runtimeEnvironmentSupportsCapability(
            host.environmentId,
            CROSS_MACHINE_RECOVERY_PRESENTATION_RUNTIME_CAPABILITY
          )
        : false
    },
    publish: (hostId, params) => {
      const host = parseExecutionHostId(hostId)
      if (host?.kind === 'local' && api.publishLocal) {
        return api.publishLocal(params)
      }
      if (host?.kind !== 'runtime') {
        throw new Error(`Presentation publish has no transport for host ${hostId}`)
      }
      return callRuntimeRpc(
        { kind: 'environment', environmentId: host.environmentId },
        'crossMachineRecovery.presentation.publish',
        params,
        { timeoutMs: PRESENTATION_PUBLISH_TIMEOUT_MS, suppressFeatureInteraction: true }
      )
    }
  }
}

/** Publishes this client's workspace views to each execution host for cross-machine recovery. */
export function useCrossMachineRecoveryPresentationPublication(): void {
  useEffect(() => {
    const api = window.api.crossMachineRecoveryPresentation
    const tracker = createHumanInputActivityTracker({
      target: window,
      initiallyFocused: document.hasFocus(),
      scope: () => inputScope(useAppStore.getState())
    })
    let publisher: CrossMachineRecoveryPresentationPublisher | null = null
    let disposed = false
    void Promise.all([api.getClientInstanceId(), api.getClientName()]).then(
      ([clientInstanceId, clientName]) => {
        if (disposed) {
          return
        }
        publisher = createCrossMachineRecoveryPresentationPublisher({
          clientInstanceId,
          clientName,
          localHostSupported: api.publishLocal !== null,
          snapshot: () => presentationSnapshot(tracker),
          transport: presentationTransport(api)
        })
        if (shouldPersistWorkspaceSession(useAppStore.getState())) {
          publisher.viewChanged()
        }
      }
    )
    const unsubscribeInput = tracker.subscribe((kind) => {
      if (!shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
      if (kind === 'input') {
        publisher?.inputChanged()
      } else {
        publisher?.viewChanged()
      }
    })
    // Why a raw subscribe: publication never renders, so it must not add React subscriptions.
    const unsubscribeStore = useAppStore.subscribe((state, previous) => {
      // Why: publishing before hydration would full-replace the host's views with nothing.
      if (!publisher || !shouldPersistWorkspaceSession(state)) {
        return
      }
      const previousKey = activePresentationSessionKey(previous)
      if (previousKey !== activePresentationSessionKey(state)) {
        if (previousKey) {
          tracker.noteWorkspaceLeft(previousKey)
        }
        publisher.workspaceFocusChanged()
        return
      }
      if (SESSION_RELEVANT_FIELDS.some((field) => state[field] !== previous[field])) {
        publisher.viewChanged()
      }
    })
    return () => {
      disposed = true
      unsubscribeStore()
      unsubscribeInput()
      tracker.dispose()
      publisher?.dispose()
    }
  }, [])
}
