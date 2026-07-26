import { randomUUID } from 'node:crypto'
import type { SshMutationExpectation } from '../shared/ssh-types'
import type { RuntimeFileReadResult } from '../shared/runtime-types'
import type { DirEntry } from '../shared/types'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import {
  AGENT_MEMORY_ENTRIES,
  AGENT_MEMORY_MAX_ENTRIES,
  AGENT_MEMORY_MAX_FILE_BYTES,
  AGENT_MEMORY_ROOT,
  AGENT_MEMORY_TEMP,
  assertMemoryId,
  parseAgentMemory,
  renderAgentMemory,
  type AgentMemoryRecord
} from './agent-memory-record'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

const MEMORY_README = `# Orca agent memory

This directory contains durable, project-scoped memory for coding agents.

- Records in \`entries/\` are immutable Markdown with YAML frontmatter.
- Newer records replace stale knowledge with an explicit \`supersedes\` link.
- Search ignores superseded records unless asked to include them.
- Sources are required so agents can verify where a memory came from.

Do not store credentials, tokens, private keys, raw transcripts, or other secrets here.
`

function isMissingPath(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bENOENT\b|no such file|not found/i.test(message)
}

function isExistingPath(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bEEXIST\b|already exists|file exists/i.test(message)
}

function requireBoundedText(result: RuntimeFileReadResult, relativePath: string): string {
  if (result.truncated || result.byteLength > AGENT_MEMORY_MAX_FILE_BYTES) {
    throw new RuntimeClientError(
      'agent_memory_too_large',
      `${relativePath} exceeds the ${AGENT_MEMORY_MAX_FILE_BYTES / 1024} KiB agent-memory file limit.`
    )
  }
  return result.content
}

export class AgentMemoryStore {
  constructor(
    private readonly client: RuntimeClient,
    private readonly worktree: string,
    private readonly mutationExpectation: SshMutationExpectation
  ) {}

  async initialize(): Promise<boolean> {
    let created = false
    for (const relativePath of [
      '.orca',
      AGENT_MEMORY_ROOT,
      AGENT_MEMORY_ENTRIES,
      AGENT_MEMORY_TEMP
    ]) {
      created = (await this.ensureDirectory(relativePath)) || created
    }
    return (await this.writeIfMissing(`${AGENT_MEMORY_ROOT}/README.md`, MEMORY_README)) || created
  }

  async readWorkspaceText(relativePath: string): Promise<string> {
    return this.readText(relativePath)
  }

  async readAllRecords(): Promise<AgentMemoryRecord[]> {
    let entries: DirEntry[]
    try {
      const response = await this.client.call<DirEntry[]>('files.readDir', {
        worktree: this.worktree,
        relativePath: AGENT_MEMORY_ENTRIES
      })
      entries = response.result
    } catch (error) {
      if (isMissingPath(error)) {
        throw new RuntimeClientError(
          'agent_memory_not_initialized',
          `No agent memory exists for this workspace. Run "orca agent memory init" first.`
        )
      }
      throw error
    }

    const files = entries.filter(
      (entry) => !entry.isDirectory && !entry.isSymlink && entry.name.endsWith('.md')
    )
    if (files.length > AGENT_MEMORY_MAX_ENTRIES) {
      throw new RuntimeClientError(
        'agent_memory_limit',
        `Agent memory contains ${files.length} records; the limit is ${AGENT_MEMORY_MAX_ENTRIES}.`
      )
    }
    return mapWithConcurrency(files, 12, async (entry): Promise<AgentMemoryRecord> => {
      const relativePath = `${AGENT_MEMORY_ENTRIES}/${entry.name}`
      const record = parseAgentMemory(await this.readText(relativePath), relativePath)
      if (`${record.id}.md` !== entry.name) {
        throw new RuntimeClientError(
          'agent_memory_invalid',
          `${relativePath} id does not match its filename.`
        )
      }
      return record
    })
  }

  async readRecord(id: string): Promise<AgentMemoryRecord> {
    assertMemoryId(id)
    const relativePath = `${AGENT_MEMORY_ENTRIES}/${id}.md`
    try {
      return parseAgentMemory(await this.readText(relativePath), relativePath)
    } catch (error) {
      if (isMissingPath(error)) {
        throw new RuntimeClientError('agent_memory_not_found', `Agent memory not found: ${id}`)
      }
      throw error
    }
  }

  async writeRecord(record: AgentMemoryRecord): Promise<string> {
    const relativePath = `${AGENT_MEMORY_ENTRIES}/${record.id}.md`
    const markdown = renderAgentMemory(record)
    if (Buffer.byteLength(markdown, 'utf8') > AGENT_MEMORY_MAX_FILE_BYTES) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Rendered memory exceeds the ${AGENT_MEMORY_MAX_FILE_BYTES / 1024} KiB file limit.`
      )
    }
    await this.writeAtomic(relativePath, markdown)
    return relativePath
  }

  private async readText(relativePath: string): Promise<string> {
    const response = await this.client.call<RuntimeFileReadResult>('files.read', {
      worktree: this.worktree,
      relativePath
    })
    return requireBoundedText(response.result, relativePath)
  }

  private async ensureDirectory(relativePath: string): Promise<boolean> {
    try {
      await this.client.call('files.createDirNoClobber', {
        worktree: this.worktree,
        relativePath,
        ...this.mutationExpectation
      })
      return true
    } catch (error) {
      if (isExistingPath(error)) {
        return false
      }
      throw error
    }
  }

  private async writeIfMissing(relativePath: string, content: string): Promise<boolean> {
    try {
      await this.writeAtomic(relativePath, content)
      return true
    } catch (error) {
      if (isExistingPath(error)) {
        return false
      }
      throw error
    }
  }

  private async writeAtomic(relativePath: string, content: string): Promise<void> {
    const tempPath = `${AGENT_MEMORY_TEMP}/${randomUUID()}.tmp`
    await this.client.call('files.writeBase64', {
      worktree: this.worktree,
      relativePath: tempPath,
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
      ...this.mutationExpectation
    })
    try {
      await this.client.call('files.rename', {
        worktree: this.worktree,
        oldRelativePath: tempPath,
        newRelativePath: relativePath,
        ...this.mutationExpectation
      })
    } catch (error) {
      await this.client
        .call('files.delete', {
          worktree: this.worktree,
          relativePath: tempPath,
          recursive: false,
          ...this.mutationExpectation
        })
        .catch(() => undefined)
      throw error
    }
  }
}
