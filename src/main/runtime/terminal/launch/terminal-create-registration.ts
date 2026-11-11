import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-terminal-contracts'
import {
  recordTerminalLaunchMetadata,
  type resolveTerminalLaunchResult
} from './terminal-launch-result'
import { seedPtyLaunchTitle } from './pty-launch-title'
import {
  recordPtySurface,
  spawnSurfaceClaimSequence
} from '../surface/pty-recorded-surface-topology'

export abstract class OrcaRuntimeWithTerminalCreateRegistration extends OrcaRuntimeWithTerminalCreateDeduplication {
  protected registerCreatedTerminal({
    result,
    preAllocatedHandle,
    workspace,
    tabId,
    leafId,
    paneKey,
    launch,
    launchOpts,
    launchTitleAt,
    presentation,
    savedStartupCwd
  }: {
    result: Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>
    preAllocatedHandle: string
    workspace: TerminalWorkspaceLaunchScope
    tabId: string
    leafId: string
    paneKey: string
    launch: ReturnType<typeof resolveTerminalLaunchResult>
    launchOpts: TerminalCreateOptions
    launchTitleAt: Parameters<typeof seedPtyLaunchTitle>[2]
    presentation: RuntimeTerminalPresentation | undefined
    savedStartupCwd: string
  }) {
    this.assertCreatedPtyRegistrationAllowed(result)
    // Provider reattachment still needs this runtime's handle and workspace binding.
    if (!result.stablePaneOwner) {
      this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
      if (result.wslDistro) {
        this.preparePtyExecutionContext(result.id, result.wslDistro)
      }
      this.registerPty(result.id, workspace.id, workspace.connectionId, {
        tabId,
        leafId,
        terminalHandle: preAllocatedHandle,
        ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
      })
    }
    const pty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (pty) {
      pty.runtimeSessionOwned = true
      if (!launch.adoptedStablePane) {
        seedPtyLaunchTitle(pty, launch.effectiveTitle, launchTitleAt, (title, at) =>
          this.setPtyManagementTitleFromObservedTitle(pty, title, at)
        )
      }
      this.watchLaunchedAgent(
        pty,
        recordTerminalLaunchMetadata(pty, result, launch, launchOpts.command)
      )
      if (!launch.adoptedStablePane) {
        this.rememberSavedTerminalLaunchResult(result.id, result)
      }
      const standing = spawnSurfaceClaimSequence(this.graphSequence)
      recordPtySurface(this.terminalIdentity, pty, tabId, paneKey, standing)
    }
    const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
    if (pty && !launch.adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
      this.publishPtyBackedMobileSessionTerminal(workspace.id, pty, {
        tabId,
        leafId,
        title: launch.effectiveTitle ?? null,
        activate: presentation === 'focused',
        selectIfNoActiveTab: presentation !== 'background',
        ...(launch.effectiveViewMode ? { viewMode: launch.effectiveViewMode } : {}),
        ...(savedStartupCwd !== workspace.path ? { startupCwd: savedStartupCwd } : {})
      })
    }
    return { pty, handle }
  }
}
