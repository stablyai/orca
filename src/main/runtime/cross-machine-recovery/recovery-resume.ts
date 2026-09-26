import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type {
  RecoveryLaunchPreferences,
  RecoveryResumeResult
} from '../../../shared/cross-machine-recovery-descriptor'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

export type RecoveryResumeParams = {
  worktree: string
  providerSessionId: string
  presentation?: 'focused' | 'background'
}

async function claimRecoveryRecord(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  providerSessionId: string
): Promise<SleepingAgentSessionRecord> {
  const outcome = await host.applyOp({ kind: 'claim-record', worktreeId, providerSessionId })
  if (!outcome.ok || !outcome.claimed) {
    throw new Error('recovery_binding_not_found')
  }
  return outcome.claimed
}

/** Claims the dormant record, launches it with host-default args, and restores it on any failure. */
export async function resumeClaimedRecoveryBinding(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  providerSessionId: string,
  options: {
    presentation?: 'focused' | 'background'
    launchPreferences?: RecoveryLaunchPreferences
  } = {}
): Promise<RecoveryResumeResult> {
  const record = await claimRecoveryRecord(host, worktreeId, providerSessionId)
  const restore = (): Promise<unknown> => host.applyOp({ kind: 'restore-record', record })
  if (host.isProviderSessionLive(providerSessionId)) {
    await restore()
    throw new Error('recovery_session_live_locally')
  }
  const pane = parsePaneKey(record.paneKey)
  try {
    // Why: terminal.ensureAgentSession semantics; omitting agentArgs keeps launch args host-owned.
    const result = await host.ensureAgentSession({
      kind: 'explicit',
      worktree: `id:${worktreeId}`,
      agent: record.agent,
      providerSession: record.providerSession,
      ...(options.launchPreferences ? { launchPreferences: options.launchPreferences } : {}),
      presentation: options.presentation ?? 'background',
      placement: { tabId: pane?.tabId ?? record.tabId, ...(pane ? { leafId: pane.leafId } : {}) }
    })
    return {
      terminalHandle: result.terminal.handle,
      disposition: result.disposition,
      localPaneKey: result.terminal.paneKey ?? record.paneKey
    }
  } catch (error) {
    await restore()
    throw error
  }
}

export async function resumeRecoveryBindingWithHost(
  host: CrossMachineRecoveryHost,
  params: RecoveryResumeParams
): Promise<RecoveryResumeResult> {
  const worktree = await host.resolveWorktree(params.worktree)
  return await resumeClaimedRecoveryBinding(host, worktree.id, params.providerSessionId, {
    presentation: params.presentation
  })
}

export async function resumeRecoveryBinding(
  runtime: OrcaRuntimeService,
  params: RecoveryResumeParams
): Promise<RecoveryResumeResult> {
  return await resumeRecoveryBindingWithHost(
    runtime.getCrossMachineRecoveryHost((repoPath) => runtime.addRepo(repoPath)),
    params
  )
}
