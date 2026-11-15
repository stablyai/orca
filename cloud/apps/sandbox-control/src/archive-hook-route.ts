// POST /v1/sandboxes/:id/archive-hook {wake?}: run the repo's archive hook before an archive or a
// delete (src/archive-hook.ts). GET answers what the control plane knows without touching the VM.
import { z } from 'zod'
import type { HostedArchiveHookResult } from '../../../../src/shared/hosted-sandbox/hosted-archive-hook-wire'
import { archiveHookMemo, recordArchiveHookMemo, runArchiveHook } from './archive-hook'
import { LifecycleError, type LifecycleDeps } from './lifecycle'
import { getSandbox, type SandboxRow } from './store'
import { wakeSandbox, type WorkspaceConfig } from './workspace-lifecycle'

export const ArchiveHookRequestSchema = z.object({ wake: z.boolean().optional() }).strict()

/** A wake normally takes seconds; past this the hook would not finish inside the desktop's wait. */
const WAKE_BUDGET_MS = 90_000

/** `archived`: its disk is never woken for the hook, so an asleep delete doesn't offer it. */
export function archiveHookView(row: SandboxRow): { memo: ReturnType<typeof archiveHookMemo>; running: boolean; archived: boolean } {
  return { memo: archiveHookMemo(row), running: row.status === 'running', archived: row.status === 'archived' }
}

async function wakeForHook(deps: LifecycleDeps, row: SandboxRow, config: WorkspaceConfig): Promise<SandboxRow | null> {
  const deadline = deps.now() + WAKE_BUDGET_MS
  let current = row
  while (deps.now() < deadline) {
    const answer = await wakeSandbox(deps, current, { ...config, waitMs: Math.min(30_000, deadline - deps.now()) })
    current = (await getSandbox(deps.db, row.id)) ?? current
    if (answer.state === 'ready' && current.session_id) {
      return current
    }
    if (answer.state !== 'waking') {
      return null
    }
  }
  return null
}

export async function runArchiveHookForRow(
  deps: LifecycleDeps,
  row: SandboxRow,
  request: z.infer<typeof ArchiveHookRequestSchema>,
  config: WorkspaceConfig,
  timeoutMs?: number
): Promise<HostedArchiveHookResult> {
  if (row.status === 'archived') {
    // Archived after its hook ran (or was waived): an archived disk is not woken for it.
    throw new LifecycleError('conflict', 'sandbox_archived')
  }
  let current = row
  if (current.status !== 'running' || !current.session_id) {
    const memo = archiveHookMemo(current)
    if (memo === 'none') {
      return { state: 'not_configured' }
    }
    if (memo === 'done') {
      return { state: 'already_ran' }
    }
    if (!request.wake) {
      return { state: 'asleep', memo }
    }
    const woken = await wakeForHook(deps, current, config)
    if (!woken) {
      return { state: 'failed', runs: [], reason: 'wake_failed' }
    }
    current = woken
  }
  const startedAt = deps.now()
  const result = await runArchiveHook(deps.provider, current.session_id!, timeoutMs ? { timeoutMs } : {})
  const memo = result.state === 'not_configured' ? 'none' : result.state === 'succeeded' ? 'done' : 'pending'
  await recordArchiveHookMemo(deps.db, current.id, memo)
  console.log(
    JSON.stringify({
      event: 'archive_hook',
      sandboxId: current.id,
      state: result.state,
      ms: deps.now() - startedAt,
      woke: current !== row,
      ...('runs' in result ? { exitCodes: result.runs.map((run) => (run.timedOut ? 'timeout' : run.exitCode)), reason: result.reason } : {})
    })
  )
  return result
}

/** Callers of an unattended archive wait on the whole request (the desktop's team list: 60 s). */
const UNATTENDED_HOOK_TIMEOUT_MS = 30_000

/**
 * Archives no desktop prepared (the public API, a phone, the team list): a running VM runs its hook
 * first, for up to 30 s. Nobody is there to choose "Archive anyway", so a failure is logged, never a refusal.
 */
export async function runArchiveHookBeforeUnattendedArchive(deps: LifecycleDeps, row: SandboxRow, config: WorkspaceConfig): Promise<void> {
  if (row.status !== 'running' || !row.session_id || archiveHookMemo(row) === 'done') {
    return
  }
  await runArchiveHookForRow(deps, row, {}, config, UNATTENDED_HOOK_TIMEOUT_MS).catch((error: unknown) =>
    console.log(JSON.stringify({ event: 'archive_hook_error', sandboxId: row.id, error: String(error).slice(0, 120) }))
  )
}
