import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { partialRuntimeStore } from '../../runtime/runtime-store-partial-fixture'
import type { AgentStartupSettings } from '../../../shared/agent-startup-plan-inputs'
import type { PtySpawnIpcArgs } from './ipc/spawn-types'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import { planPaneAgentLaunch } from './ipc/spawn-agent-launch'
import { resetAgentLaunchPanesForTests } from '../../agent-launch/agent-launch-pane-attachment'

/** Only physical workspace discovery is supplied; intent, host planning and compilation are real. */
export async function planQueuedPaneAgentLaunch(
  agentLaunch: PtySpawnIpcArgs['agentLaunch'],
  settings: AgentStartupSettings,
  coordinates = {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111'
  }
): Promise<PtySpawnIpcArgs> {
  const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => settings }))
  const discovery = vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: coordinates.worktreeId,
    path: '/synthetic/project',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const unexpected = (): never => {
    throw new Error('Unexpected physical spawn')
  }
  const ctx = createPtyIpcSpawnState(
    {
      runtime,
      getLocalPtyStartupPromise: unexpected,
      adoptStablePane: unexpected,
      assertWorkspaceAcceptsNewPty: unexpected,
      resolvePtySpawnStartupCwd: unexpected,
      transitionSpawnHiddenRendererPtyDeliveryState: unexpected,
      trustedTerminalHandleEnv: new Set(),
      sendPtySpawnedToRenderer: unexpected,
      syncPtyBackgroundedDelivery: unexpected,
      stopReplacedPty: unexpected,
      prepareCodexResumeHome: unexpected,
      resolveCodexResumeLaunch: unexpected,
      noCodexResumeLaunch: unexpected,
      reconcileSharedRuntimeResumeHome: unexpected,
      stripSequencedStartupResumeArgv: unexpected
    },
    { ...coordinates, cols: 80, rows: 24, agentLaunch }
  )
  try {
    await planPaneAgentLaunch(ctx)
    ctx.paneAgentLaunch?.refuseIfClosed()
    return ctx.args
  } finally {
    resetAgentLaunchPanesForTests()
    discovery.mockRestore()
  }
}
