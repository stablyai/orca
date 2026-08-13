import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun,
  AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'
import type { Store } from '../persistence'
import type { AutomationRunTargetResult } from './run-target-resolution'

const MAX_HEADLESS_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

export type HeadlessAutomationDispatchLaunch = {
  workspaceId: string
  workspaceDisplayName?: string | null
  terminalSessionId: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  completion?: Promise<{
    status: 'completed' | 'dispatch_failed'
    outputSnapshot?: AutomationRunOutputSnapshot | null
    error?: string | null
  }>
}

export type HeadlessAutomationDispatcher = (request: {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
}) => Promise<HeadlessAutomationDispatchLaunch>

export function createHeadlessAutomationOutputSnapshotBuffer(): {
  append: (chunk: string) => void
  snapshot: () => AutomationRunOutputSnapshot | null
} {
  const chunks: string[] = []
  let totalChars = 0
  let truncated = false

  return {
    append(chunk): void {
      if (!chunk) {
        return
      }
      chunks.push(chunk)
      totalChars += chunk.length
      let overflowChars = totalChars - MAX_HEADLESS_OUTPUT_SNAPSHOT_CHARS
      while (overflowChars > 0 && chunks.length > 0) {
        const firstChunk = chunks[0]!
        if (firstChunk.length <= overflowChars) {
          chunks.shift()
          totalChars -= firstChunk.length
          overflowChars -= firstChunk.length
          truncated = true
          continue
        }
        chunks[0] = firstChunk.slice(overflowChars)
        totalChars -= overflowChars
        truncated = true
        overflowChars = 0
      }
    },
    snapshot(): AutomationRunOutputSnapshot | null {
      const content = chunks.join('').trim()
      if (!content) {
        return null
      }
      return {
        format: 'plain_text',
        content,
        capturedAt: Date.now(),
        truncated
      }
    }
  }
}

/** Serve-mode run dispatch: precheck, launch through the dispatcher, then persist
 *  the launch target and its (possibly late) completion. */
export async function requestHeadlessAutomationDispatch(args: {
  store: Pick<Store, 'updateAutomationRun'>
  dispatch: HeadlessAutomationDispatcher
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  runPrecheck: () => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
}): Promise<AutomationRun> {
  const { store, dispatch, automation, run, target, markDispatchResult } = args
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck ? await args.runPrecheck() : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return store.updateAutomationRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }
  try {
    const launch = await dispatch({ automation, run, target })
    const launchRunTarget = {
      workspaceId: launch.workspaceId,
      workspaceDisplayName: launch.workspaceDisplayName ?? null,
      terminalSessionId: launch.terminalSessionId,
      terminalPaneKey: launch.terminalPaneKey ?? null,
      terminalPtyId: launch.terminalPtyId ?? null
    }
    const updated = store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      ...launchRunTarget,
      error: null
    })
    if (launch.completion) {
      void launch.completion
        .then((completion) =>
          markDispatchResult({
            runId: run.id,
            status: completion.status,
            ...launchRunTarget,
            precheckResult,
            outputSnapshot: completion.outputSnapshot ?? null,
            error: completion.error ?? null
          })
        )
        .catch((error) =>
          markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            precheckResult,
            error: error instanceof Error ? error.message : String(error)
          })
        )
        // Why: nothing awaits this chain, so a failing markDispatchResult would
        // otherwise surface as an unhandled rejection.
        .catch((error) => {
          console.warn('[automations] Failed to persist headless dispatch result:', error)
        })
    }
    return updated
  } catch (error) {
    return store.updateAutomationRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
