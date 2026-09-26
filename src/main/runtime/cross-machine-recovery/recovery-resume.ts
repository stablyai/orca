import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  recoveryBindingKeyOf,
  selectRecoveryBinding,
  type RecoveryBindingKey,
  type RecoveryBindingSelector
} from '../../../shared/cross-machine-recovery-binding-key'
import type {
  RecoveryLaunchPreferences,
  RecoveryResumeResult
} from '../../../shared/cross-machine-recovery-descriptor'
import { listRecoveryRecords } from '../../../shared/cross-machine-recovery-session-ops'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

export type RecoveryResumeParams = {
  worktree: string
  binding: RecoveryBindingSelector
  presentation?: 'focused' | 'background'
}

async function claimRecoveryRecord(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  binding: RecoveryBindingKey
): Promise<SleepingAgentSessionRecord> {
  const outcome = await host.applyOp({ kind: 'claim-record', worktreeId, binding })
  if (!outcome.ok || !outcome.claimed) {
    throw new Error('recovery_binding_not_found')
  }
  return outcome.claimed
}

/** Claims the dormant record, launches it with host-default args, and restores it on any failure. */
export async function resumeClaimedRecoveryBinding(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  binding: RecoveryBindingKey,
  options: {
    presentation?: 'focused' | 'background'
    launchPreferences?: RecoveryLaunchPreferences
  } = {}
): Promise<RecoveryResumeResult> {
  const record = await claimRecoveryRecord(host, worktreeId, binding)
  const restore = (): Promise<unknown> => host.applyOp({ kind: 'restore-record', record })
  if (host.isProviderSessionLive(recoveryBindingKeyOf(record))) {
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
  const records = listRecoveryRecords(
    host.getLocalSession().sleepingAgentSessionsByPaneKey,
    worktree.id
  )
  const selection = selectRecoveryBinding(records, params.binding)
  if (!selection.ok) {
    throw new Error(selection.code)
  }
  return await resumeClaimedRecoveryBinding(
    host,
    worktree.id,
    recoveryBindingKeyOf(selection.binding),
    { presentation: params.presentation }
  )
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
