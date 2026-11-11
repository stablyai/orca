import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'

/** A job that ends between prompts never reports it, so a running report holds the agent this long. */
const ACP_BACKGROUND_JOB_HOLD_MS = 4 * 60 * 60_000

export class AcpRunningBackgroundJobs {
  private readonly reportedAt = new Map<string, number>()

  observe(update: ToolCallUpdate, dialect: AcpDialect, at: number): void {
    const job = dialect.toolBackgroundJob?.(update)
    if (job === 'running') {
      this.reportedAt.set(update.toolCallId, at)
    } else if (job === 'settled') {
      this.reportedAt.delete(update.toolCallId)
    }
  }

  holdsAgent(now: number): boolean {
    for (const [toolCallId, at] of this.reportedAt) {
      if (now - at >= ACP_BACKGROUND_JOB_HOLD_MS) {
        this.reportedAt.delete(toolCallId)
      }
    }
    return this.reportedAt.size > 0
  }
}
