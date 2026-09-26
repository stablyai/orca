import { AgentLaunchPaneAlreadyLiveError } from '../../../shared/agent-launch-pane-already-live'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  recoveryBindingKeyOf,
  recoveryBindingKeyString,
  selectRecoveryBinding,
  type RecoveryBindingKey,
  type RecoveryBindingSelector
} from '../../../shared/cross-machine-recovery-binding-key'
import type {
  RecoveryImportBindingResult,
  RecoveryLaunchPreferences,
  RecoveryResumeResult
} from '../../../shared/cross-machine-recovery-descriptor'
import { listRecoveryRecords } from '../../../shared/cross-machine-recovery-session-ops'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { PlannedRecoveryBinding } from './recovery-import-plan'
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

export const CLAUDE_APPEND_SYSTEM_PROMPT_FLAG = '--append-system-prompt'

async function recoveryResumeExtraArgv(
  host: CrossMachineRecoveryHost,
  record: SleepingAgentSessionRecord
): Promise<string[]> {
  const text = record.recovery?.appendSystemPrompt
  if (record.agent !== 'claude' || !text || !(await host.supportsClaudeAppendSystemPrompt())) {
    return []
  }
  return [CLAUDE_APPEND_SYSTEM_PROMPT_FLAG, text]
}

/** Durable so a replay racing the launch, or after a restart, never re-adds a consumed binding. */
export async function recordConsumedRecoveryBinding(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  binding: RecoveryBindingKey
): Promise<void> {
  const provenance = host.getWorktreeMeta(worktreeId)?.recoveryProvenance
  const key = recoveryBindingKeyString(binding)
  if (!provenance || provenance.consumedBindings?.includes(key)) {
    return
  }
  await host.setRecoveryProvenance(worktreeId, {
    ...provenance,
    consumedBindings: [...(provenance.consumedBindings ?? []), key]
  })
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
  // Why: held before the claim so a concurrent replay never re-adds the record this resume consumes.
  const release = host.resumeHolds.hold(binding)
  try {
    const record = await claimRecoveryRecord(host, worktreeId, binding)
    const restore = (): Promise<unknown> => host.applyOp({ kind: 'restore-record', record })
    if (host.isProviderSessionLive(recoveryBindingKeyOf(record))) {
      await restore()
      throw new Error('recovery_session_live_locally')
    }
    const pane = parsePaneKey(record.paneKey)
    const extraResumeArgv = await recoveryResumeExtraArgv(host, record)
    let result: Awaited<ReturnType<CrossMachineRecoveryHost['ensureAgentSession']>>
    try {
      // Why: terminal.ensureAgentSession semantics; omitting agentArgs keeps launch args host-owned.
      result = await host.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${worktreeId}`,
        agent: record.agent,
        providerSession: record.providerSession,
        ...(options.launchPreferences ? { launchPreferences: options.launchPreferences } : {}),
        presentation: options.presentation ?? 'background',
        ...(extraResumeArgv.length > 0 ? { extraResumeArgv } : {}),
        placement: { tabId: pane?.tabId ?? record.tabId, ...(pane ? { leafId: pane.leafId } : {}) },
        // Why: a dormant pane has no PTY; adopting one that appeared would resume into a shell.
        requireFreshPane: true
      })
    } catch (error) {
      await restore()
      throw error instanceof AgentLaunchPaneAlreadyLiveError
        ? new Error('recovery_placement_occupied')
        : error
    }
    await recordConsumedRecoveryBinding(host, worktreeId, binding)
    return {
      terminalHandle: result.terminal.handle,
      disposition: result.disposition,
      localPaneKey: result.terminal.paneKey ?? record.paneKey
    }
  } finally {
    release()
  }
}

export async function resumeSelectedRecoveryBindings(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  planned: readonly PlannedRecoveryBinding[],
  resumeKeys: ReadonlySet<string>
): Promise<RecoveryImportBindingResult[]> {
  const results: RecoveryImportBindingResult[] = []
  for (const { binding, record, result } of planned) {
    if (!record || !resumeKeys.has(recoveryBindingKeyString(recoveryBindingKeyOf(binding)))) {
      results.push(result)
      continue
    }
    try {
      const resumed = await resumeClaimedRecoveryBinding(
        host,
        worktreeId,
        recoveryBindingKeyOf(record),
        {
          launchPreferences: binding.launch.launchPreferences
        }
      )
      results.push({
        ...result,
        localPaneKey: resumed.localPaneKey,
        status: 'resumed',
        terminalHandle: resumed.terminalHandle
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Why: a failed launch restores the record, so the binding stays dormant rather than lost.
      const status = reason === 'recovery_session_live_locally' ? 'refused' : 'dormant'
      results.push({ ...result, status, reason })
    }
  }
  return results
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
