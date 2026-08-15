import type {
  Automation,
  AutomationRun,
  AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import type { AutomationRunTargetResult } from './run-target-resolution'

const MAX_HEADLESS_OUTPUT_SNAPSHOT_CHARS = 256 * 1024
export const DEFAULT_CODEX_HEADLESS_LAUNCH_TIMEOUT_MS = 2 * 60 * 1000

export type HeadlessAutomationLaunchReady =
  | Promise<void>
  | ((launchDeadlineAt: number) => Promise<void>)

export type HeadlessAutomationDispatchLaunch = {
  workspaceId: string
  workspaceDisplayName?: string | null
  terminalSessionId: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  /** Resolves only after provider-owned evidence confirms that the agent launched. */
  launchReady?: HeadlessAutomationLaunchReady
  /** Stops an active launch that failed to produce its launch postcondition. */
  cleanup?: () => Promise<void>
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
