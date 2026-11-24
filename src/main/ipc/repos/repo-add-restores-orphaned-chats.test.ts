import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, chatHost } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  chatHost: { current: null as unknown }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => chatHost.current
}))
vi.mock('../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))
vi.mock('../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoLocalMetadata: vi.fn(async () => ({}))
}))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('./repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))

import type { Repo } from '../../../shared/repository/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import { registerRepoCreationHandlers } from './repo-creation-handlers'
import {
  beginProjectRemoval,
  resetRemovedProjectLedgerForTests
} from '../../runtime/repositories/removed-project-ledger'

const OLD = '382f7d9d-4836-4375-9a02-529501637cc7'

function fakeStore(): Store & { repos: Repo[] } {
  const repos: Repo[] = []
  return {
    repos,
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
    },
    getSettings: () => ({})
  } as unknown as Store & { repos: Repo[] }
}

function fakeChats(workspaceId: string) {
  const records = [{ sessionId: 'chat-1', location: { executionHostId: 'local', workspaceId } }]
  const updateRecord = vi.fn(
    async (sessionId: string, command: { kind: 'workspace'; from: string; to: string }) => {
      const record = records.find((entry) => entry.sessionId === sessionId)
      if (record && record.location.workspaceId === command.from) {
        record.location.workspaceId = command.to
      }
    }
  )
  return { records, updateRecord, listConversations: () => records }
}

async function addViaIpc(path: string): Promise<Repo> {
  const handler = handlers.get('repos:add')
  if (!handler) {
    throw new Error('repos:add not registered')
  }
  const result = (await handler({}, { path, kind: 'folder' })) as { repo: Repo } | { error: string }
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result.repo
}

describe('repos:add (desktop Add project path) re-keys a removed project chats (#40409)', () => {
  let dir: string
  let store: ReturnType<typeof fakeStore>

  beforeEach(async () => {
    resetRemovedProjectLedgerForTests()
    handlers.clear()
    dir = await mkdtemp(join(tmpdir(), 'orca-readd-'))
    store = fakeStore()
    registerRepoCreationHandlers({} as never, store, vi.fn())
  })

  afterEach(async () => {
    chatHost.current = null
    await rm(dir, { recursive: true, force: true })
  })

  it('moves the chats of the removed copy of the same folder to the new id', async () => {
    const chats = fakeChats(`${OLD}::${dir}`)
    chatHost.current = { deps: { store: chats } }
    beginProjectRemoval({ id: OLD, path: dir, kind: 'folder' } as Repo)()

    const repo = await addViaIpc(dir)

    expect(repo.id).not.toBe(OLD)
    await vi.waitFor(() => expect(chats.records[0].location.workspaceId).toBe(`${repo.id}::${dir}`))
  })

  it('leaves chats alone when the removed project was a different folder identity', async () => {
    const chats = fakeChats(`${OLD}::${dir}`)
    chatHost.current = { deps: { store: chats } }
    beginProjectRemoval({ id: OLD, path: dir, kind: 'folder' } as Repo, async () => 'folder:0:1')()

    await addViaIpc(dir)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(chats.updateRecord).not.toHaveBeenCalled()
    expect(chats.records[0].location.workspaceId).toBe(`${OLD}::${dir}`)
  })

  it('waits for a removal still tearing down before moving chats', async () => {
    const chats = fakeChats(`${OLD}::${dir}`)
    chatHost.current = { deps: { store: chats } }
    const finishRemoval = beginProjectRemoval({ id: OLD, path: dir, kind: 'folder' } as Repo)

    const repo = await addViaIpc(dir)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(chats.updateRecord).not.toHaveBeenCalled()

    finishRemoval()
    await vi.waitFor(() => expect(chats.records[0].location.workspaceId).toBe(`${repo.id}::${dir}`))
  })
})
