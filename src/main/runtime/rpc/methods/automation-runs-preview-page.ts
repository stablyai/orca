import type { AutomationRun, AutomationRunsPage } from '../../../../shared/automations-types'
import { automationRunCursor } from '../../../../shared/automation-run-cursor'
import { sliceAtCodeUnitLimit } from '../../../../shared/surrogate-safe-text-slice'

export const AUTOMATION_RUN_OUTPUT_PREVIEW_CHARS = 8_000

function previewAutomationRun(run: AutomationRun): AutomationRun {
  const snapshot = run.outputSnapshot
  if (!snapshot || snapshot.content.length <= AUTOMATION_RUN_OUTPUT_PREVIEW_CHARS) {
    return run
  }
  return {
    ...run,
    outputSnapshot: {
      ...snapshot,
      content: sliceAtCodeUnitLimit(snapshot.content, AUTOMATION_RUN_OUTPUT_PREVIEW_CHARS),
      truncated: true
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Preview rows, keeping those whose exact `{ runs, nextCursor }` reply fits `maxBytes`; the cursor resumes at the cut. */
export function previewAutomationRunsPage(
  page: AutomationRunsPage,
  maxBytes: number
): AutomationRunsPage {
  const runs = page.runs.map(previewAutomationRun)
  let rowBytes = 0
  for (let count = 0; count < runs.length; count += 1) {
    rowBytes += jsonBytes(runs[count]) + (count > 0 ? 1 : 0)
    const nextCursor = count + 1 < runs.length ? automationRunCursor(runs[count]) : page.nextCursor
    if (rowBytes + jsonBytes({ runs: [], nextCursor }) <= maxBytes) {
      continue
    }
    if (count === 0) {
      throw new Error('This automation run is too large to list over this connection.')
    }
    return { runs: runs.slice(0, count), nextCursor: automationRunCursor(runs[count - 1]) }
  }
  return { runs, nextCursor: page.nextCursor }
}
