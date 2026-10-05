import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import {
  LspSessionManager,
  type LspSessionHandle,
  type LspSessionManagerDeps
} from './lsp-session-manager'
import type { LspSessionConfig } from './lsp-session'
import type { ResolvedLspServer } from './lsp-server-command'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'r1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    languageServers: { enabled: { typescript: true, 'ruby-lsp': true } },
    ...overrides
  }
}

function setup(overrides: Partial<LspSessionManagerDeps> = {}) {
  const created: { config: LspSessionConfig; handle: LspSessionHandle }[] = []
  let current = repo()
  const manager = new LspSessionManager({
    getRepo: (id) => (id === current.id ? current : undefined),
    resolveWorktreeRoot: async (path) => path,
    resolveCommand: async () => ({
      command: { program: 'x', args: [], env: {} },
      initializationOptions: null
    }),
    createSession: (config) => {
      const handle: LspSessionHandle = {
        ready: Promise.resolve(),
        attachPort: vi.fn(),
        dispose: vi.fn(async () => {})
      }
      created.push({ config, handle })
      return handle
    },
    maxSessionsPerServer: 2,
    ...overrides
  })
  return { manager, created, setRepo: (next: Repo) => (current = next) }
}

describe('LspSessionManager', () => {
  it('refuses remote, disabled and unknown worktrees', async () => {
    const { manager, setRepo } = setup()
    expect(await manager.acquire({ worktreeId: 'nope', languageId: 'ruby' })).toEqual({
      ok: false,
      reason: 'invalid-worktree'
    })
    expect(await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'python' })).toEqual({
      ok: false,
      reason: 'disabled'
    })
    setRepo(repo({ connectionId: 'ssh-1' }))
    expect(await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })).toEqual({
      ok: false,
      reason: 'unsupported-host'
    })
  })

  it('reuses one session per server and root', async () => {
    const { manager, created } = setup()
    const a = await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'typescript' })
    const b = await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'javascript' })
    expect(a.ok && b.ok && a.session === b.session).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('reports unavailable when the server binary is missing', async () => {
    const { manager } = setup({ resolveCommand: async () => null })
    expect(await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
  })

  it('stops respawning after three unexpected exits until settings change', async () => {
    const { manager, created } = setup()
    for (let i = 0; i < 3; i++) {
      await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })
      created.at(-1)?.config.onExit(true)
    }
    expect(await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    manager.disposeForRepo('r1')
    expect((await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })).ok).toBe(true)
  })

  it('evicts the least recently used session over the per-server cap', async () => {
    const { manager, created } = setup()
    await manager.acquire({ worktreeId: 'r1::/w1', languageId: 'ruby' })
    await manager.acquire({ worktreeId: 'r1::/w2', languageId: 'ruby' })
    await manager.acquire({ worktreeId: 'r1::/w1', languageId: 'ruby' })
    await manager.acquire({ worktreeId: 'r1::/w3', languageId: 'ruby' })
    expect(created[1].handle.dispose).toHaveBeenCalled()
    expect(created[0].handle.dispose).not.toHaveBeenCalled()
  })

  it('disposes sessions of a removed worktree, including folder-workspace ids', async () => {
    const { manager, created } = setup()
    const folderId = 'r1::/repo::workspace:3f1c2d4e-0000-4000-8000-000000000000'
    await manager.acquire({ worktreeId: folderId, languageId: 'ruby' })
    manager.disposeForWorktree(folderId)
    expect(created[0].handle.dispose).toHaveBeenCalled()
  })

  it('aborts pending acquire when disposeForRepo is called', async () => {
    let resolve: (v: ResolvedLspServer | null) => void = () => {}
    const deferred = new Promise<ResolvedLspServer | null>((r) => {
      resolve = r
    })
    const { manager, created } = setup({
      resolveCommand: () => deferred
    })
    const acquiring = manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })
    manager.disposeForRepo('r1')
    resolve({ command: { program: 'x', args: [], env: {} }, initializationOptions: null })
    const result = await acquiring
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(created).toHaveLength(0)
  })

  it('aborts pending acquire when disposeAll is called', async () => {
    let resolve: (v: ResolvedLspServer | null) => void = () => {}
    const deferred = new Promise<ResolvedLspServer | null>((r) => {
      resolve = r
    })
    const { manager, created } = setup({
      resolveCommand: () => deferred
    })
    const acquiring = manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })
    await manager.disposeAll()
    resolve({ command: { program: 'x', args: [], env: {} }, initializationOptions: null })
    const result = await acquiring
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(created).toHaveLength(0)
  })

  it('creates only one session for concurrent acquires of same key', async () => {
    let resolve: (v: ResolvedLspServer | null) => void = () => {}
    const deferred = new Promise<ResolvedLspServer | null>((r) => {
      resolve = r
    })
    const { manager, created } = setup({
      resolveCommand: () => deferred
    })
    const promise1 = manager.acquire({ worktreeId: 'r1::/repo', languageId: 'typescript' })
    const promise2 = manager.acquire({ worktreeId: 'r1::/repo', languageId: 'typescript' })
    resolve({ command: { program: 'x', args: [], env: {} }, initializationOptions: null })
    const [a, b] = await Promise.all([promise1, promise2])
    expect(created).toHaveLength(1)
    expect(a.ok && b.ok && a.session === b.session).toBe(true)
  })

  it('returns unavailable when resolveCommand rejects', async () => {
    const { manager } = setup({
      resolveCommand: async () => {
        throw new Error('not installed')
      }
    })
    const result = await manager.acquire({ worktreeId: 'r1::/repo', languageId: 'ruby' })
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })
})
