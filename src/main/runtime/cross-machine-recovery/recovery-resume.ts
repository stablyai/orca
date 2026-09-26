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

/** Exclusive: a second Resume or release of the same binding fails instead of racing the first. */
export function holdRecoveryBinding(
  host: CrossMachineRecoveryHost,
  binding: RecoveryBindingKey
): () => void {
  const release = host.resumeHolds.hold(binding)
  if (!release) {
    throw new Error('recovery_session_live_locally')
  }
  return release
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
  const key = recoveryBindingKeyString(binding)
  // Why an update: read inside the serialized write, so concurrent consumptions never drop one.
  await host.updateRecoveryProvenance(worktreeId, (provenance) =>
    !provenance || provenance.consumedBindings?.includes(key)
      ? provenance
      : { ...provenance, consumedBindings: [...(provenance.consumedBindings ?? []), key] }
  )
}

/** Launches a dormant record with host-default args, then consumes it; the record stays until then. */
export async function resumeRecoveryRecord(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  record: SleepingAgentSessionRecord,
  presentation: 'focused' | 'background' = 'background'
): Promise<RecoveryResumeResult> {
  const binding = recoveryBindingKeyOf(record)
  const release = holdRecoveryBinding(host, binding)
  try {
    if (host.isProviderSessionLive(binding)) {
      throw new Error('recovery_session_live_locally')
    }
    const pane = parsePaneKey(record.paneKey)
    const extraResumeArgv = await recoveryResumeExtraArgv(host, record)
    const launchPreferences = record.recovery?.launchPreferences
    let result: Awaited<ReturnType<CrossMachineRecoveryHost['ensureAgentSession']>>
    try {
      // Why: terminal.ensureAgentSession semantics; omitting agentArgs keeps launch args host-owned.
      // The dormant record stays in place meanwhile, so a pane mounting now waits instead of
      // starting a shell.
      result = await host.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${worktreeId}`,
        agent: record.agent,
        providerSession: record.providerSession,
        ...(launchPreferences ? { launchPreferences } : {}),
        presentation,
        ...(extraResumeArgv.length > 0 ? { extraResumeArgv } : {}),
        placement: { tabId: pane?.tabId ?? record.tabId, ...(pane ? { leafId: pane.leafId } : {}) },
        // Why: a dormant pane has no PTY; adopting one that appeared would resume into a shell.
        requireFreshPane: true
      })
    } catch (error) {
      throw error instanceof AgentLaunchPaneAlreadyLiveError
        ? new Error('recovery_placement_occupied')
        : error
    }
    await host.applyOp({ kind: 'claim-record', worktreeId, binding })
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
      const resumed = await resumeRecoveryRecord(host, worktreeId, record)
      results.push({
        ...result,
        localPaneKey: resumed.localPaneKey,
        status: 'resumed',
        terminalHandle: resumed.terminalHandle
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Why: a failed launch never removed the record, so the binding stays dormant rather than lost.
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
  return await resumeRecoveryRecord(host, worktree.id, selection.binding, params.presentation)
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
