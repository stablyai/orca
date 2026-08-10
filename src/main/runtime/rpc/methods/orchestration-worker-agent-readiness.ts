import type { OrcaRuntimeService } from '../../orca-runtime'

/** Pause after first tui-idle so MCP/skills boot can leave idle before inject (#13488). */
export const WORKER_AGENT_TUI_IDLE_SETTLE_MS = process.env.VITEST ? 0 : 1_000

type TerminalWait = Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>

/**
 * Wait for agent TUI readiness before worker-start injects the task.
 * Newly launched agents (not `--terminal`) settle after the first idle so a
 * premature Claude/Codex idle blip during MCP load does not accept the paste
 * before the composer will submit.
 */
export async function waitForWorkerAgentTuiReady(args: {
  runtime: Pick<OrcaRuntimeService, 'waitForTerminal'>
  terminalHandle: string
  timeoutMs: number
  /** True when the caller bound an already-running agent via `--terminal`. */
  externalTerminal: boolean
}): Promise<TerminalWait> {
  const startedAt = Date.now()
  const first = await args.runtime.waitForTerminal(args.terminalHandle, {
    condition: 'tui-idle',
    timeoutMs: args.timeoutMs
  })
  if (!first.satisfied || args.externalTerminal) {
    return first
  }

  if (WORKER_AGENT_TUI_IDLE_SETTLE_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, WORKER_AGENT_TUI_IDLE_SETTLE_MS))
  }

  // Why: re-confirm idle after settle so a boot-time idle blip that becomes
  // "working" (MCP load) is waited out before paste+Enter (#13488).
  const remainingMs = args.timeoutMs - (Date.now() - startedAt)
  // Why: settle is part of the caller budget — do not floor a second wait past the deadline.
  if (remainingMs <= 0) {
    throw new Error('timeout')
  }
  return args.runtime.waitForTerminal(args.terminalHandle, {
    condition: 'tui-idle',
    timeoutMs: remainingMs
  })
}
