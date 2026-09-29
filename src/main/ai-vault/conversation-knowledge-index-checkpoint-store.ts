import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'

export type ConversationKnowledgeIndexCheckpoint = {
  version: 1
  state: 'running' | 'stopped'
  config: {
    generatorAgent: TuiAgent
    generatorModel: string
    scopePaths?: string[]
    language?: string
  }
  total: number
  completed: number
  failed: number
  pending: { executionHostId: string; agent: AiVaultAgent; sessionId: string }[]
}

const FILE_NAME = 'conversation-knowledge-index.json'

export class ConversationKnowledgeIndexCheckpointStore {
  constructor(private readonly userDataPath: string) {}

  async read(): Promise<ConversationKnowledgeIndexCheckpoint | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath(), 'utf8'))
      return isCheckpoint(value) ? value : null
    } catch {
      return null
    }
  }

  write(checkpoint: ConversationKnowledgeIndexCheckpoint): void {
    writeDurableSecureJsonFile(this.filePath(), checkpoint)
  }

  private filePath(): string {
    return join(ensureActiveOrcaProfile(this.userDataPath).profileDirectory, FILE_NAME)
  }
}

function isCheckpoint(value: unknown): value is ConversationKnowledgeIndexCheckpoint {
  if (!isRecord(value)) {
    return false
  }
  const record = value
  const config = isRecord(record.config) ? record.config : null
  return (
    record.version === 1 &&
    (record.state === 'running' || record.state === 'stopped') &&
    config !== null &&
    typeof config.generatorAgent === 'string' &&
    typeof config.generatorModel === 'string' &&
    typeof record.total === 'number' &&
    typeof record.completed === 'number' &&
    typeof record.failed === 'number' &&
    Array.isArray(record.pending)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
