import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../shared/types'
import type { RuntimeFileReadResult } from '../shared/runtime-types'
import { AgentMemoryRepository } from './agent-memory-repository'
import type { RuntimeClient, RuntimeRpcSuccess } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

type RpcParams = Record<string, unknown>

class MemoryRuntimeClient {
  readonly isRemote = false
  readonly directories = new Set([''])
  readonly files = new Map<string, string>()
  readonly calls: string[] = []
  readonly requests: { method: string; params: RpcParams }[] = []
  connectionId: string | null = null
  connectionGeneration = 0

  async call<TResult>(method: string, paramsValue?: unknown): Promise<RuntimeRpcSuccess<TResult>> {
    const params = (paramsValue ?? {}) as RpcParams
    const relativePath = String(params.relativePath ?? '')
    this.calls.push(method)
    this.requests.push({ method, params })

    if (method === 'worktree.show') {
      return this.success({
        worktree: {
          id: 'wt-1',
          repoId: 'repo-1',
          displayName: 'Memory workspace'
        }
      } as TResult)
    }
    if (method === 'repo.list') {
      return this.success({
        repos: [{ id: 'repo-1', connectionId: this.connectionId }]
      } as TResult)
    }
    if (method === 'ssh.getState') {
      return this.success({
        state: {
          targetId: this.connectionId,
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: this.connectionGeneration
        }
      } as TResult)
    }
    if (method === 'files.createDirNoClobber') {
      if (this.directories.has(relativePath) || this.files.has(relativePath)) {
        throw new RuntimeClientError('runtime_error', `EEXIST: ${relativePath}`)
      }
      if (!this.directories.has(dirname(relativePath).replace(/^\.$/, ''))) {
        throw new RuntimeClientError('runtime_error', `ENOENT: ${relativePath}`)
      }
      this.directories.add(relativePath)
      return this.success({ ok: true } as TResult)
    }
    if (method === 'files.writeBase64') {
      if (this.files.has(relativePath)) {
        throw new RuntimeClientError('runtime_error', `EEXIST: ${relativePath}`)
      }
      this.files.set(
        relativePath,
        Buffer.from(String(params.contentBase64), 'base64').toString('utf8')
      )
      return this.success({ ok: true } as TResult)
    }
    if (method === 'files.rename') {
      const oldPath = String(params.oldRelativePath)
      const newPath = String(params.newRelativePath)
      if (this.files.has(newPath)) {
        throw new RuntimeClientError('runtime_error', `EEXIST: ${newPath}`)
      }
      const content = this.files.get(oldPath)
      if (content === undefined) {
        throw new RuntimeClientError('runtime_error', `ENOENT: ${oldPath}`)
      }
      this.files.delete(oldPath)
      this.files.set(newPath, content)
      return this.success({ ok: true } as TResult)
    }
    if (method === 'files.delete') {
      this.files.delete(relativePath)
      return this.success({ ok: true } as TResult)
    }
    if (method === 'files.read') {
      const content = this.files.get(relativePath)
      if (content === undefined) {
        throw new RuntimeClientError('runtime_error', `ENOENT: ${relativePath}`)
      }
      const result: RuntimeFileReadResult = {
        worktree: 'wt-1',
        relativePath,
        content,
        truncated: false,
        byteLength: Buffer.byteLength(content)
      }
      return this.success(result as TResult)
    }
    if (method === 'files.readDir') {
      if (!this.directories.has(relativePath)) {
        throw new RuntimeClientError('runtime_error', `ENOENT: ${relativePath}`)
      }
      const prefix = relativePath ? `${relativePath}/` : ''
      const entries = new Map<string, DirEntry>()
      for (const directory of this.directories) {
        if (!directory.startsWith(prefix) || directory === relativePath) {
          continue
        }
        const name = directory.slice(prefix.length).split('/')[0]
        entries.set(name, { name, isDirectory: true, isSymlink: false })
      }
      for (const file of this.files.keys()) {
        if (!file.startsWith(prefix)) {
          continue
        }
        const name = file.slice(prefix.length).split('/')[0]
        if (!name.includes('/')) {
          entries.set(name, { name, isDirectory: false, isSymlink: false })
        }
      }
      return this.success([...entries.values()] as TResult)
    }
    throw new Error(`Unexpected method: ${method}`)
  }

  private success<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
    return { id: 'test', ok: true, result, _meta: { runtimeId: 'test' } }
  }
}

function repository(client = new MemoryRuntimeClient()): {
  client: MemoryRuntimeClient
  repository: AgentMemoryRepository
} {
  return {
    client,
    repository: new AgentMemoryRepository(client as unknown as RuntimeClient, 'id:wt-1', {
      expectedExecutionHostId: 'local'
    })
  }
}

describe('AgentMemoryRepository', () => {
  it('captures SSH host ownership before mutating a remote workspace', async () => {
    const client = new MemoryRuntimeClient()
    client.connectionId = 'ssh-1'
    client.connectionGeneration = 7
    const memory = await AgentMemoryRepository.connect(
      client as unknown as RuntimeClient,
      'id:wt-1'
    )

    await memory.initialize()

    const mutations = client.requests.filter(({ method }) => method.startsWith('files.'))
    expect(mutations.length).toBeGreaterThan(0)
    expect(
      mutations.every(
        ({ params }) =>
          params.expectedExecutionHostId === 'ssh:ssh-1' &&
          params.expectedSshTargetId === 'ssh-1' &&
          params.expectedSshConnectionGeneration === 7
      )
    ).toBe(true)
  })

  it('initializes idempotently and preserves its README', async () => {
    const { client, repository: memory } = repository()

    expect(await memory.initialize()).toMatchObject({ created: true })
    const readme = client.files.get('.orca/memory/README.md')
    expect(await memory.initialize()).toMatchObject({ created: false })
    expect(client.files.get('.orca/memory/README.md')).toBe(readme)
  })

  it('writes immutable cited records through temp-file rename', async () => {
    const { client, repository: memory } = repository()

    const result = await memory.remember({
      title: 'Build boundary',
      body: 'The renderer build must stay below the release memory budget.',
      kind: 'constraint',
      confidence: 'high',
      sources: ['docs/build.md'],
      tags: ['build']
    })

    expect(result.citation).toBe(`[memory:${result.record.id}]`)
    expect(client.files.get(result.relativePath)).toContain('schema: orca.agent-memory/v1')
    expect([...client.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
    expect(client.calls).toContain('files.rename')
    expect(
      client.requests
        .filter(({ method }) => method.startsWith('files.'))
        .every(({ params }) => params.expectedExecutionHostId === 'local')
    ).toBe(true)
  })

  it('retrieves current records and exposes supersession history', async () => {
    const { repository: memory } = repository()
    const oldRecord = await memory.remember({
      title: 'Build command',
      body: 'Use the legacy renderer command.',
      kind: 'fact',
      confidence: 'medium',
      sources: ['commit:old'],
      tags: ['build']
    })
    const newRecord = await memory.remember({
      title: 'Build command v2',
      body: 'Use pnpm run build:web.',
      kind: 'fact',
      confidence: 'high',
      sources: ['package.json'],
      tags: ['build'],
      supersedes: oldRecord.record.id
    })

    const current = await memory.search('build command', {
      includeSuperseded: false,
      limit: 8
    })
    const history = await memory.search('build command', {
      includeSuperseded: true,
      limit: 8
    })

    expect(current.matches.map((match) => match.record.id)).toEqual([newRecord.record.id])
    expect(history.matches).toHaveLength(2)
    expect((await memory.show(oldRecord.record.id)).status.supersededBy).toEqual([
      newRecord.record.id
    ])
  })

  it('requires an existing record before accepting supersession', async () => {
    const { repository: memory } = repository()

    await expect(
      memory.remember({
        title: 'Replacement',
        body: 'Replacement body.',
        kind: 'decision',
        confidence: 'high',
        sources: ['issue:#1'],
        tags: [],
        supersedes: 'mem_20260726T120000Z_missing-record_deadbeef'
      })
    ).rejects.toThrow('Agent memory not found')
  })

  it('validates records before initializing the store', async () => {
    const { client, repository: memory } = repository()

    await expect(
      memory.remember({
        title: 'Uncited fact',
        body: 'This should not mutate the workspace.',
        kind: 'fact',
        confidence: 'low',
        sources: [],
        tags: []
      })
    ).rejects.toThrow('Provide 1-12 --source values')
    expect(client.directories.has('.orca')).toBe(false)
  })

  it('reads long bodies from the selected workspace provider', async () => {
    const { client, repository: memory } = repository()
    client.files.set('notes/outcome.md', 'Remote workspace outcome')

    await expect(memory.readWorkspaceText('notes/outcome.md')).resolves.toBe(
      'Remote workspace outcome'
    )
  })

  it('does not enumerate symlinked memory entries', async () => {
    const { client, repository: memory } = repository()
    await memory.initialize()
    const call = vi.spyOn(client, 'call').mockImplementationOnce(
      async () =>
        ({
          id: 'test',
          ok: true,
          result: [
            { name: 'outside.md', isDirectory: false, isSymlink: true }
          ] satisfies DirEntry[],
          _meta: { runtimeId: 'test' }
        }) as RuntimeRpcSuccess<never>
    )

    await expect(
      memory.search('outside', { includeSuperseded: false, limit: 8 })
    ).resolves.toMatchObject({ matches: [] })
    expect(call).toHaveBeenCalled()
  })
})
