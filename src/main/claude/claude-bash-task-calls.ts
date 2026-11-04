import { BoundedMap } from '../../shared/bounded-map'
import { runsOrcaOrchestrationWait } from '../../shared/orca-cli-invocations'
import { agentLaunchedByShellCommand } from '../../shared/shell-command-agent-launch'
import type { TerminalAgent } from '../../shared/agent-status/identity/terminal-agent'
import {
  claudeRecord,
  claudeToolUses,
  readClaudeMessageEnvelope
} from './structured/journal/claude-structured-item-translation'

export type ClaudeBashTaskCall = {
  /** Blocks on `orca orchestration check --wait`: waiting on worker agents. */
  awaitsAgents?: true
  /** Runs another agent's CLI, so the task is that agent's work. */
  launchedAgent?: TerminalAgent
}

/** What Bash calls run, by tool_use_id, until their background task starts. */
export class ClaudeBashTaskCalls {
  // A foreground call never starts a task (or is moved to the background later), so bound what waits for one.
  private readonly pending = new BoundedMap<string, ClaudeBashTaskCall>({ maxEntries: 256 })

  observe(message: Record<string, unknown>): void {
    const envelope = readClaudeMessageEnvelope(message)
    for (const tool of envelope ? claudeToolUses(envelope) : []) {
      const command = claudeRecord(tool.input)?.command
      if (runsOrcaOrchestrationWait(command)) {
        this.pending.set(tool.id, { awaitsAgents: true })
        continue
      }
      const launchedAgent = agentLaunchedByShellCommand(command)
      if (launchedAgent) {
        this.pending.set(tool.id, { launchedAgent })
      }
    }
  }

  take(toolUseId: string | undefined): ClaudeBashTaskCall | undefined {
    if (toolUseId === undefined) {
      return undefined
    }
    const call = this.pending.get(toolUseId)
    this.pending.delete(toolUseId)
    return call
  }

  clear(): void {
    this.pending.clear()
  }
}
