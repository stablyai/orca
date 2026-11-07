import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunOutputSnapshot,
  AutomationRunSetupSkippedReason
} from '../../shared/automations-types'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunFailureCodeFields } from '../../shared/automation-run-failure-copy'

const MAX_HEADLESS_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

export type AutomationLaunch = {
  sessionKind?: 'terminal' | 'chat'
  chatSessionId?: string | null
  workspaceId: string
  workspaceDisplayName?: string | null
  terminalSessionId: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  /** Settles once a newly opened terminal's prompt is handed over, or with why it was not; never rejects. */
  delivery?: Promise<{ error: string | null }>
  setupSkippedReason?: AutomationRunSetupSkippedReason
  setupSkippedContent?: AutomationDispatchResult['setupSkippedContent']
  completion?: Promise<
    {
      status: 'completed' | 'dispatch_failed'
      outputSnapshot?: AutomationRunOutputSnapshot | null
      error?: string | null
    } & AutomationRunFailureCodeFields
  >
}

export type AutomationLauncher = (request: {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
}) => Promise<AutomationLaunch>

/** Main's terminal launcher; `available` is false while no window graph can hold run terminals. */
export type AutomationTerminalLauncher = {
  launch: AutomationLauncher
  available(): boolean
}

export class AutomationRunLaunchError extends Error {
  constructor(
    message: string,
    readonly target?: AutomationLaunch
  ) {
    super(message)
  }
}

export function createAutomationOutputSnapshotBuffer(): {
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
