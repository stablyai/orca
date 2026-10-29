import type { TerminalLaunchResult } from '../../../../shared/agent-session-resume'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { resolveLaunchCommandPaneAgent } from '../../runtime-agent-launch-resolution'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { recordTerminalLaunchMetadata } from './terminal-launch-result'

type CreatedTerminalTitleHost = {
  getSessionCustomTitle(sessionId: string): string | null
  setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void
  rememberManualTerminalTitle(tabId: string, title: string): void
}

export type CreatedTerminalPtyHost = CreatedTerminalTitleHost & {
  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null
  rememberSavedTerminalLaunchResult(ptyId: string, result: TerminalLaunchResult): void
}

type CreatedLaunch = Parameters<typeof recordTerminalLaunchMetadata>[2]
type CreatedSpawnResult = Parameters<typeof recordTerminalLaunchMetadata>[1]

/** Bind the spawned PTY to this runtime's title, launch facts, and surface claim. */
export function finishCreatedTerminalPty(
  host: CreatedTerminalPtyHost,
  result: CreatedSpawnResult,
  presentation: string | undefined,
  launch: CreatedLaunch,
  launchTitleAt: { sequence: number; epochMs: number },
  tabId: string,
  launchOpts: {
    command?: string | null
    resumeProviderSession?: { id: string } | null
  },
  paneKey: string,
  graphSequence: number
): RuntimePtyWorktreeRecord | null {
  const pty = host.getOrCreatePtyWorktreeRecord(result.id)
  if (!pty) {
    return null
  }
  pty.runtimeSessionOwned = true
  applyCreatedTerminalManualTitle(host, pty, presentation, launch, launchTitleAt, tabId, launchOpts)
  recordTerminalLaunchMetadata(pty, result, launch)
  if (!launch.adoptedStablePane) {
    pty.launchCommandAgent = result.agentResumeRefused
      ? null
      : resolveLaunchCommandPaneAgent(launchOpts.command)
    host.rememberSavedTerminalLaunchResult(result.id, result)
  }
  recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(graphSequence))
  return pty
}

/** Keep a resume custom title without locking a background shell's launch label. */
export function applyCreatedTerminalManualTitle(
  host: CreatedTerminalTitleHost,
  pty: RuntimePtyWorktreeRecord,
  presentation: string | undefined,
  launch: { effectiveTitle: string | null | undefined; adoptedStablePane: boolean },
  launchTitleAt: { sequence: number; epochMs: number },
  tabId: string,
  launchOpts: { resumeProviderSession?: { id: string } | null }
): void {
  pty.providerSessionId = launchOpts.resumeProviderSession?.id ?? null
  if (launch.adoptedStablePane) {
    return
  }
  const manualTitle =
    (presentation === 'background' && !pty.providerSessionId ? undefined : launch.effectiveTitle) ||
    (pty.providerSessionId ? host.getSessionCustomTitle(pty.providerSessionId) : null) ||
    null
  seedPtyLaunchTitle(pty, manualTitle ?? launch.effectiveTitle, launchTitleAt, (title, at) =>
    host.setPtyManagementTitleFromObservedTitle(pty, title, at)
  )
  if (manualTitle) {
    pty.customTitle = manualTitle
    host.rememberManualTerminalTitle(tabId, manualTitle)
  }
}

/** Spawn completion must not give a launch label newer authority than titles received in flight. */
export function seedPtyLaunchTitle(
  pty: RuntimePtyWorktreeRecord,
  title: string | null | undefined,
  observedAt: { sequence: number; epochMs: number },
  setManagementTitle: (title: string, observedAt: number) => void
): void {
  if (Math.max(pty.titleUpdatedAt ?? 0, pty.lastOscTitleAt ?? 0) > observedAt.sequence) {
    return
  }
  pty.title = title || null
  pty.titleUpdatedAt = title ? observedAt.sequence : null
  pty.titleObservedAtEpochMs = title ? observedAt.epochMs : null
  if (title) {
    setManagementTitle(title, observedAt.sequence)
  }
}
