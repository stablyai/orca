import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import { automationRunRecency } from '../../shared/automation-session-reuse'
import type { Store } from '../persistence'
import { runOwnHandle } from './headless-automation-agent-launch'
import {
  AGENT_HOOKS_REVIEW_BLOCKED_ERROR,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

type HookReviewTerminalHost = Pick<
  AutomationRunTerminalHost,
  'getTerminalHandleForPaneKey' | 'waitForTerminal'
> & {
  getTerminalPtyIdForHandle(handle: string): string | null
  readTerminalClientUse(ptyId: string): 'used' | 'unused' | 'unknown'
  closeTerminal(handle: string): Promise<unknown>
}

async function isStillOnHookReview(
  runtime: HookReviewTerminalHost,
  handle: string
): Promise<boolean> {
  try {
    const wait = await runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    return wait.blockedReason === 'agent-hooks-review-prompt'
  } catch {
    return false
  }
}

/** Earlier runs wait on the same hook review; keep only the newest stuck tab per automation. */
export async function closeEarlierHookReviewRunTerminals(
  deps: {
    store: Pick<Store, 'listAutomationRuns'>
    runtime: HookReviewTerminalHost
    markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  },
  latest: AutomationRun
): Promise<void> {
  const { runtime } = deps
  const stale = deps.store
    .listAutomationRuns(latest.automationId)
    .filter(
      (run) =>
        run.error === AGENT_HOOKS_REVIEW_BLOCKED_ERROR &&
        automationRunRecency(run) < automationRunRecency(latest)
    )
  for (const run of stale) {
    // Leave a pane that now holds another process, may have been used, or moved past the prompt.
    const handle = runOwnHandle(runtime, run)
    if (
      !handle ||
      !run.terminalPtyId ||
      runtime.readTerminalClientUse(run.terminalPtyId) !== 'unused' ||
      !(await isStillOnHookReview(runtime, handle))
    ) {
      continue
    }
    try {
      await runtime.closeTerminal(handle)
      await deps.markDispatchResult({
        runId: run.id,
        status: run.status,
        error: run.error,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    } catch (error) {
      console.warn('[automations] could not close a run stuck on hook review:', error)
    }
  }
}
