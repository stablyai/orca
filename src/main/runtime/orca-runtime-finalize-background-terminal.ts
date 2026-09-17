// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by characterization tests.
import * as dependencies from './orca-runtime-create-terminal-dependencies'
import type { OrcaRuntimeWithCreateTerminal } from './orca-runtime-create-terminal'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-types'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'

export async function finalizeBackgroundTerminalCreate(
  runtime: OrcaRuntimeWithCreateTerminal,
  args: {
    result: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
    workspace: Awaited<
      ReturnType<OrcaRuntimeWithCreateTerminal['resolveTerminalWorkspaceLaunchScope']>
    >
    launchOpts: Awaited<
      ReturnType<OrcaRuntimeWithCreateTerminal['resolveAgentTerminalCreateOptions']>
    >
    presentation: RuntimeTerminalPresentation | undefined
    cwd: string
    preAllocatedHandle: string
    tabId: string
    leafId: string
    paneKey: string
    launchToken: string | undefined
    effectiveLaunchConfig: SleepingAgentLaunchConfig | undefined
    reportPtySpawnCommitted: () => void
    surfaceOwner?: boolean
  }
): Promise<dependencies.RuntimeTerminalCreate> {
  const {
    result,
    workspace,
    launchOpts,
    presentation,
    cwd,
    launchToken,
    effectiveLaunchConfig,
    reportPtySpawnCommitted,
    surfaceOwner
  } = args
  let { preAllocatedHandle, tabId, leafId, paneKey } = args
  if (!result.stablePaneOwner) {
    reportPtySpawnCommitted()
  }
  const adoptedStablePane = Boolean(result.stablePaneOwner)
  if (result.agentSessionEnsure) {
    const canonicalSurface = result.agentSessionEnsure.owner.surface
    preAllocatedHandle = canonicalSurface.terminalHandle
    tabId = canonicalSurface.tabId
    leafId = canonicalSurface.leafId
    paneKey = dependencies.makePaneKey(tabId, leafId)
  } else if (result.stablePaneOwner) {
    preAllocatedHandle = result.stablePaneOwner.handle
    tabId = result.stablePaneOwner.tabId
    leafId = result.stablePaneOwner.leafId
    paneKey = dependencies.makePaneKey(tabId, leafId)
  }
  try {
    runtime.assertPtyDidNotExitBeforeRegistration(result.id, result.incarnationId)
  } catch (error) {
    if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
      runtime.releaseRejectedPtyRegistrationFence(result.id, result.incarnationId)
    }
    throw error
  }
  runtime.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
  if (result.wslDistro) {
    runtime.preparePtyExecutionContext(result.id, result.wslDistro)
  }
  runtime.registerPty(result.id, workspace.id, workspace.connectionId, {
    tabId,
    leafId,
    terminalHandle: preAllocatedHandle,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
  })
  if (result.agentSessionEnsure && runtime.onAgentSessionCommitted) {
    try {
      runtime.onAgentSessionCommitted({
        result: result.agentSessionEnsure,
        paneKey,
        tabId,
        leafId,
        worktreeId: workspace.id,
        connectionId: workspace.connectionId,
        launchToken,
        agentType: launchOpts.launchAgent ?? result.agentSessionEnsure.owner.claim.agent
      })
    } catch (error) {
      // Membership is bookkeeping. A failed status publication must never turn a committed execution into a failed terminal create.
      console.warn('[terminal-create] launch membership publication failed:', error)
    }
  }
  if (launchOpts.structuredAgentSessionId) {
    dependencies.agentSessionPtyWriteGate.bindPty(result.id, launchOpts.structuredAgentSessionId)
  }
  const pty = runtime.getOrCreatePtyWorktreeRecord(result.id)
  if (pty) {
    pty.runtimeSessionOwned = true
    if (!adoptedStablePane) {
      if (launchOpts.title) {
        const observedAt = runtime.nextTitleObservationSequence()
        pty.title = launchOpts.title
        pty.titleUpdatedAt = observedAt
        runtime.setPtyManagementTitleFromObservedTitle(pty, launchOpts.title, observedAt)
      } else {
        pty.title = null
        pty.titleUpdatedAt = null
      }
      pty.launchConfig = effectiveLaunchConfig
        ? dependencies.copySleepingAgentLaunchConfig(effectiveLaunchConfig)
        : null
      pty.launchToken = launchToken ?? null
      pty.launchIncarnationId = launchToken ? pty.incarnationId : null
      pty.launchAgent = launchOpts.launchAgent ?? null
    }
    pty.tabId = tabId
    pty.paneKey = paneKey
  }
  const handle = pty ? runtime.issuePtyHandle(pty) : preAllocatedHandle
  if (pty && !adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
    runtime.publishPtyBackedMobileSessionTerminal(workspace.id, pty, {
      tabId,
      leafId,
      title: launchOpts.title ?? null,
      activate: presentation === 'focused',
      selectIfNoActiveTab: presentation !== 'background',
      ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
      ...(cwd !== workspace.path ? { startupCwd: cwd } : {})
    })
  }
  let surface: dependencies.RuntimeTerminalCreate['surface'] = 'background'
  let warning: string | undefined
  if (presentation !== 'background' && runtime.notifier?.revealTerminalSession) {
    try {
      await runtime.notifier.revealTerminalSession(workspace.id, {
        ptyId: result.id,
        title: launchOpts.title ?? null,
        ...(cwd !== workspace.path ? { cwd } : {}),
        ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
        ...(launchToken ? { launchToken } : {}),
        ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
        ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
        activate: presentation === 'focused',
        ...(presentation ? { presentation } : {}),
        ...dependencies.ownerSurfacing(surfaceOwner !== false),
        tabId,
        leafId
      })
      surface = 'visible'
    } catch (err) {
      console.warn(`[terminal-create] failed to create inactive tab for ${result.id}:`, err)
      warning = dependencies.createTerminalRevealWarning(handle, err)
    }
  } else if (presentation !== 'background') {
    warning = dependencies.createTerminalRevealWarning(handle)
  }
  return {
    handle,
    tabId,
    paneKey,
    ptyId: result.id,
    worktreeId: workspace.id,
    title: pty?.title ?? launchOpts.title ?? null,
    ...runtime.getPtyExecutionHostMetadata(result.id),
    surface,
    ...(result.pid ? { processId: result.pid } : {}),
    ...(result.agentSessionEnsure
      ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
      : {}),
    ...(adoptedStablePane ? { isReattach: true as const } : {}),
    ...(warning ? { warning } : {})
  }
}
