import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultScanWork } from '../../shared/ai-vault-scan-progress'
import { sessionFileExecutionNamespace } from './codex-session-root-dedup'

type AgentTally = {
  files: Set<string>
  databases: number
  openSources: number
}

/** What one scan has found and read so far, for the progress it reports. */
export class AiVaultScanTally {
  private readonly agents = new Map<AiVaultAgent, AgentTally>()
  private stage: AiVaultScanWork['stage'] = 'finding'
  private readDone = 0
  private readTotal = 0

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
    // Why: a hard link is one file within an execution namespace; WSL distros
    // can reuse the same device and inode numbers for unrelated files.
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

  startReading(total: number): void {
    this.stage = 'reading'
    this.readTotal += total
  }

  addRead(count: number): void {
    this.readDone += count
  }

  snapshot(): AiVaultScanWork {
    const agents: AiVaultScanWork['agents'] = []
    for (const [agent, tally] of this.agents) {
      if (tally.files.size > 0 || tally.databases > 0 || tally.openSources > 0) {
        agents.push({
          agent,
          files: tally.files.size,
          databases: tally.databases,
          walking: tally.openSources > 0
        })
      }
    }
    // Discovery settles in any order; a fixed order keeps the rows from jumping.
    agents.sort((a, b) => AI_VAULT_AGENTS.indexOf(a.agent) - AI_VAULT_AGENTS.indexOf(b.agent))
    return {
      stage: this.stage,
      agents,
      read: {
        done: Math.min(this.readDone, this.readTotal),
        total: this.readTotal
      }
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
