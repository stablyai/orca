import { randomUUID } from 'node:crypto'
import type { SshConnectionState, SshMutationExpectation } from '../shared/ssh-types'
import type { RuntimeRepoList, RuntimeWorktreeRecord } from '../shared/runtime-types'
import {
  AGENT_MEMORY_ENTRIES,
  AGENT_MEMORY_MAX_BODY_BYTES,
  AGENT_MEMORY_MAX_SOURCES,
  AGENT_MEMORY_MAX_SOURCE_LENGTH,
  AGENT_MEMORY_MAX_TAGS,
  AGENT_MEMORY_MAX_TITLE_LENGTH,
  AGENT_MEMORY_ROOT,
  normalizeMemoryTags,
  searchAgentMemories,
  type AgentMemoryConfidence,
  type AgentMemoryKind,
  type AgentMemoryRecord,
  type AgentMemorySearchMatch,
  type AgentMemoryStatus
} from './agent-memory-record'
import { AgentMemoryStore } from './agent-memory-store'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type RememberAgentMemoryInput = {
  title: string
  body: string
  kind: AgentMemoryKind
  confidence: AgentMemoryConfidence
  sources: string[]
  tags: string[]
  supersedes?: string
}

export type RememberAgentMemoryResult = {
  worktree: string
  citation: string
  relativePath: string
  record: AgentMemoryRecord
}

export type SearchAgentMemoryResult = {
  worktree: string
  query: string
  matches: AgentMemorySearchMatch[]
}

export type ShowAgentMemoryResult = {
  worktree: string
  citation: string
  relativePath: string
  status: AgentMemoryStatus
}

function memoryId(title: string, now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const slug =
    title
      .normalize('NFKD')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'memory'
  return `mem_${timestamp}_${slug}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export class AgentMemoryRepository {
  private readonly store: AgentMemoryStore

  constructor(
    client: RuntimeClient,
    private readonly worktree: string,
    mutationExpectation: SshMutationExpectation
  ) {
    this.store = new AgentMemoryStore(client, worktree, mutationExpectation)
  }

  static async connect(
    client: RuntimeClient,
    worktreeSelector: string
  ): Promise<AgentMemoryRepository> {
    const worktreeResponse = await client.call<{ worktree: RuntimeWorktreeRecord }>(
      'worktree.show',
      { worktree: worktreeSelector }
    )
    const worktree = worktreeResponse.result.worktree
    const reposResponse = await client.call<RuntimeRepoList>('repo.list')
    const repo = reposResponse.result.repos.find((candidate) => candidate.id === worktree.repoId)
    if (!repo) {
      throw new RuntimeClientError(
        'agent_memory_workspace_unavailable',
        `The repository for workspace ${worktree.id} is no longer registered.`
      )
    }

    const connectionId = repo.connectionId?.trim()
    if (!connectionId) {
      return new AgentMemoryRepository(client, `id:${worktree.id}`, {
        expectedExecutionHostId: 'local'
      })
    }

    const stateResponse = await client.call<{ state: SshConnectionState | null }>('ssh.getState', {
      targetId: connectionId
    })
    const generation = stateResponse.result.state?.connectionGeneration
    if (generation === undefined) {
      throw new RuntimeClientError(
        'agent_memory_workspace_unavailable',
        `SSH workspace ${worktree.displayName} is not connected.`
      )
    }
    return new AgentMemoryRepository(client, `id:${worktree.id}`, {
      expectedExecutionHostId: `ssh:${connectionId}`,
      expectedSshTargetId: connectionId,
      expectedSshConnectionGeneration: generation
    })
  }

  async initialize(): Promise<{ worktree: string; relativePath: string; created: boolean }> {
    const created = await this.store.initialize()
    return { worktree: this.worktree, relativePath: AGENT_MEMORY_ROOT, created }
  }

  async remember(input: RememberAgentMemoryInput): Promise<RememberAgentMemoryResult> {
    const title = input.title.trim()
    const body = input.body.trim()
    const sources = [...new Set(input.sources.map((source) => source.trim()).filter(Boolean))]
    const tags = normalizeMemoryTags(input.tags)
    if (title.length === 0 || title.length > AGENT_MEMORY_MAX_TITLE_LENGTH) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Memory title must contain 1-${AGENT_MEMORY_MAX_TITLE_LENGTH} characters.`
      )
    }
    if (Buffer.byteLength(body, 'utf8') === 0) {
      throw new RuntimeClientError('invalid_argument', 'Memory body cannot be empty.')
    }
    if (Buffer.byteLength(body, 'utf8') > AGENT_MEMORY_MAX_BODY_BYTES) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Memory body exceeds ${AGENT_MEMORY_MAX_BODY_BYTES / 1024} KiB.`
      )
    }
    if (
      sources.length === 0 ||
      sources.length > AGENT_MEMORY_MAX_SOURCES ||
      sources.some((source) => source.length > AGENT_MEMORY_MAX_SOURCE_LENGTH)
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Provide 1-${AGENT_MEMORY_MAX_SOURCES} --source values; each must be at most ${AGENT_MEMORY_MAX_SOURCE_LENGTH} characters.`
      )
    }
    if (tags.length > AGENT_MEMORY_MAX_TAGS) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Memory records support at most ${AGENT_MEMORY_MAX_TAGS} tags.`
      )
    }
    if (input.supersedes) {
      await this.store.readRecord(input.supersedes)
    }
    await this.initialize()

    const id = memoryId(title)
    const record: AgentMemoryRecord = {
      id,
      title,
      kind: input.kind,
      confidence: input.confidence,
      createdAt: new Date().toISOString(),
      sources,
      tags,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      body
    }
    const relativePath = await this.store.writeRecord(record)
    return { worktree: this.worktree, citation: `[memory:${id}]`, relativePath, record }
  }

  async search(
    query: string,
    options: {
      includeSuperseded: boolean
      limit: number
      kind?: AgentMemoryKind
      tag?: string
    }
  ): Promise<SearchAgentMemoryResult> {
    const records = await this.store.readAllRecords()
    return {
      worktree: this.worktree,
      query,
      matches: searchAgentMemories(records, query, options)
    }
  }

  async show(id: string): Promise<ShowAgentMemoryResult> {
    const record = await this.store.readRecord(id)
    const records = await this.store.readAllRecords()
    const successors = records
      .filter((candidate) => candidate.supersedes === id)
      .map((candidate) => candidate.id)
      .sort((left, right) => left.localeCompare(right))
    return {
      worktree: this.worktree,
      citation: `[memory:${id}]`,
      relativePath: `${AGENT_MEMORY_ENTRIES}/${id}.md`,
      status: { record, ...(successors.length > 0 ? { supersededBy: successors } : {}) }
    }
  }

  async readWorkspaceText(relativePath: string): Promise<string> {
    return this.store.readWorkspaceText(relativePath)
  }
}
