import { BoundedMap } from '../../shared/bounded-map'
import { runsOrcaOrchestrationWait } from '../../shared/orca-cli-invocations'
import {
  claudeRecord,
  claudeToolUses,
  readClaudeMessageEnvelope
} from './structured/journal/claude-structured-item-translation'

/** Bash calls that block on `orca orchestration check --wait`, by tool_use_id, until their background task starts. */
export class ClaudeAgentWaitCalls {
  // A foreground wait never starts a task (or is moved to the background later), so bound what waits for one.
  private readonly pending = new BoundedMap<string, true>({ maxEntries: 256 })

  observe(message: Record<string, unknown>): void {
    const envelope = readClaudeMessageEnvelope(message)
    for (const tool of envelope ? claudeToolUses(envelope) : []) {
      if (runsOrcaOrchestrationWait(claudeRecord(tool.input)?.command)) {
        this.pending.set(tool.id, true)
      }
    }
  }

  take(toolUseId: string | undefined): boolean {
    return toolUseId !== undefined && this.pending.delete(toolUseId)
  }

  clear(): void {
    this.pending.clear()
  }
}
