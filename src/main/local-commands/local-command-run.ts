import type {
  LocalCommandSettleParams,
  LocalCommandSettleResult
} from '../../shared/local-commands/local-command-contract'
import type { LocalCommandAuditEntry } from '../../shared/local-commands/local-command-desktop-types'
import type { LocalCommandExecutionOutcome } from './local-command-executor'

export type RequestBase = {
  requestId: string
  sandboxId: string
  command: string
  cwd: string | null
  agent: string | null
}

export type ApprovedLocalCommandDeps = {
  settle: (
    environmentId: string,
    params: LocalCommandSettleParams
  ) => Promise<Pick<LocalCommandSettleResult, 'accepted'> | null>
  execute: (input: {
    command: string
    cwd: string
    timeoutSec: number
  }) => Promise<LocalCommandExecutionOutcome>
  audit: (entry: Omit<LocalCommandAuditEntry, 'at' | 'workspaceLabel'>) => void
}

/** Claims the request, runs it, reports the result and records it. Never runs an unclaimed request. */
export async function runApprovedLocalCommand(
  deps: ApprovedLocalCommandDeps,
  environmentId: string,
  base: RequestBase & { cwd: string },
  timeoutSec: number,
  outcome: 'allowed-once' | 'always-allowed' | 'auto-allowed'
): Promise<void> {
  // Claim first: if another computer or the workspace already settled it, nothing runs here.
  const started = await deps.settle(environmentId, {
    requestId: base.requestId,
    outcome: 'started'
  })
  if (!started?.accepted) {
    deps.audit({ ...base, outcome: 'closed', detail: 'The workspace no longer waited for it.' })
    return
  }
  try {
    const result = await deps.execute({ command: base.command, cwd: base.cwd, timeoutSec })
    const { stdoutBytes, stderrBytes, ...wire } = result
    deps.audit({
      ...base,
      outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutBytes,
      stderrBytes,
      truncated: result.truncated
    })
    await deps.settle(environmentId, {
      requestId: base.requestId,
      outcome: 'finished',
      result: wire
    })
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    deps.audit({ ...base, outcome, detail: `Could not start: ${message}` })
    await deps.settle(environmentId, { requestId: base.requestId, outcome: 'failed', message })
  }
}
