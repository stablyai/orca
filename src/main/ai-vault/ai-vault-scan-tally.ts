import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultScanWork } from '../../shared/ai-vault-scan-progress'
import { AiVaultScanWorkload } from './ai-vault-scan-workload'
import { sessionFileExecutionNamespace } from './codex-session-root-dedup'

type AgentTally = {
  files: Set<string>
  databases: number
  openSources: number
}

export class AiVaultScanTally {
  private readonly agents = new Map<AiVaultAgent, AgentTally>()
  private stage: AiVaultScanWork['stage'] = 'finding'
  readonly workload = new AiVaultScanWorkload()

  openSource(agent: AiVaultAgent): () => void {
    const tally = this.agent(agent)
    tally.openSources++
    let open = true
    return () => {
      if (open) {
        open = false
        tally.openSources--
      }
    }
  }

  addFile(agent: AiVaultAgent, file: { path: string; dev?: number; ino?: number }): void {
    // Inodes identify hardlinks only within one execution namespace; WSL distros can reuse them.
    const identity =
      typeof file.dev === 'number' &&
      typeof file.ino === 'number' &&
      Number.isSafeInteger(file.dev) &&
      Number.isSafeInteger(file.ino) &&
      !(file.dev === 0 && file.ino === 0)
        ? `${sessionFileExecutionNamespace(file.path)}:${file.dev}:${file.ino}`
        : file.path
    this.agent(agent).files.add(identity)
  }

  addDatabases(agent: AiVaultAgent, count: number): void {
    this.agent(agent).databases += count
  }

  startReading(): void {
    this.stage = 'reading'
  }

  snapshot(): AiVaultScanWork {
    const agents: AiVaultScanWork['agents'] = []
    for (const agent of AI_VAULT_AGENTS) {
      if (this.workload.has(agent)) {
        this.agent(agent)
      }
    }
    for (const [agent, tally] of this.agents) {
      if (
        tally.files.size > 0 ||
        tally.databases > 0 ||
        tally.openSources > 0 ||
        this.workload.has(agent)
      ) {
        agents.push({
          agent,
          files: tally.files.size,
          databases: tally.databases,
          walking: tally.openSources > 0,
          ...(this.stage === 'reading' ? { read: this.workload.snapshot(agent) } : {})
        })
      }
    }
    // Fixed provider order prevents rows jumping as discovery finishes.
    agents.sort((a, b) => AI_VAULT_AGENTS.indexOf(a.agent) - AI_VAULT_AGENTS.indexOf(b.agent))
    return {
      stage: this.stage,
      agents,
      read: this.stage === 'reading' ? this.workload.total() : { done: 0, total: 0 }
    }
  }

  private agent(agent: AiVaultAgent): AgentTally {
    let tally = this.agents.get(agent)
    if (!tally) {
      tally = { files: new Set(), databases: 0, openSources: 0 }
      this.agents.set(agent, tally)
    }
    return tally
  }
}
