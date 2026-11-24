import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => null
}))
vi.mock('../../git/command-runner/git-exec-file', () => ({
  gitExecFileAsync: vi.fn()
}))

import type { Repo } from '../../../shared/repository/repo-types'
import { restoreOrphanedChats } from './orphaned-chat-restore'
import {
  beginProjectRemoval,
  REMOVED_PROJECT_RETENTION_MS,
  resetRemovedProjectLedgerForTests,
  settledRemovedProjects,
  simulateAppRestartForTests,
  useRemovedProjectLedgerFile
} from './removed-project-ledger'

const OLD = '382f7d9d-4836-4375-9a02-529501637cc7'
const NEW = '7319a84d-f391-4530-b66d-b3ca61acfbb6'
const NEW2 = '0b6c6c1e-1a52-4d55-a6a8-9a0d3f6f4b11'
const PATH = '/work/app'
const oldRepo: Repo = { id: OLD, path: PATH, kind: 'git' } as Repo
const newRepo: Repo = { id: NEW, path: PATH, kind: 'git' } as Repo
const newRepo2: Repo = { id: NEW2, path: PATH, kind: 'git' } as Repo
const sameRepo = async (): Promise<string> => 'git:root-a'
const otherRepo = async (): Promise<string> => 'git:root-b'

function chatStore() {
  const records = ['chat-1', 'chat-2'].map((sessionId) => ({
    sessionId,
    location: { executionHostId: 'local', workspaceId: `${OLD}::${PATH}` }
  }))
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

describe('removed project ledger survives an app restart (RE-ADD-02)', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    resetRemovedProjectLedgerForTests()
    dir = mkdtempSync(join(tmpdir(), 'removed-ledger-'))
    file = join(dir, 'removed-projects.json')
    useRemovedProjectLedgerFile(file)
  })
  afterEach(() => {
    vi.useRealTimers()
    resetRemovedProjectLedgerForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('remove, restart, re-add: chats move and the open tabs come back in order', async () => {
    beginProjectRemoval(oldRepo, sameRepo, ['chat-2', 'chat-1'])()
    await settledRemovedProjects() // the row is on disk once the removal has settled
    simulateAppRestartForTests()
    const store = chatStore()
    const showSessionTabs = vi.fn(async () => undefined)
    const moved = await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => store,
      chatTabs: () => ({ showSessionTabs }),
      readIdentity: sameRepo
    })
    expect(moved).toBe(2)
    expect(store.records.every((r) => r.location.workspaceId === `${NEW}::${PATH}`)).toBe(true)
    expect(showSessionTabs).toHaveBeenCalledWith(['chat-2', 'chat-1'])
  })

  it('another repository at the same path gets nothing after a restart, and the entry stays', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    await settledRemovedProjects() // the row is on disk once the removal has settled
    simulateAppRestartForTests()
    const store = chatStore()
    const moved = await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => store,
      readIdentity: otherRepo
    })
    expect(moved).toBe(0)
    expect(store.updateRecord).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toContain(OLD)
  })

  it('is consumed once: a second re-add after another restart gets nothing', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    await settledRemovedProjects() // the row is on disk once the removal has settled
    simulateAppRestartForTests()
    const store = chatStore()
    const deps = { chatStore: () => store, readIdentity: sameRepo }
    expect(await restoreOrphanedChats(newRepo, { ...deps, isLive: (id) => id === NEW })).toBe(2)
    simulateAppRestartForTests()
    const again = chatStore()
    expect(
      await restoreOrphanedChats(newRepo2, {
        chatStore: () => again,
        readIdentity: sameRepo,
        isLive: (id) => id === NEW2
      })
    ).toBe(0)
  })

  it('drops entries older than the retention', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    beginProjectRemoval(oldRepo, sameRepo)()
    await settledRemovedProjects() // the row is on disk once the removal has settled
    simulateAppRestartForTests()
    vi.setSystemTime(
      new Date(Date.parse('2026-01-01T00:00:00Z') + REMOVED_PROJECT_RETENTION_MS + 1)
    )
    const moved = await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => chatStore(),
      readIdentity: sameRepo
    })
    expect(moved).toBe(0)
  })

  it('a missing or corrupt ledger file never breaks a re-add', async () => {
    expect(existsSync(file)).toBe(false)
    simulateAppRestartForTests()
    expect(
      await restoreOrphanedChats(newRepo, {
        isLive: (id) => id === NEW,
        chatStore: () => chatStore(),
        readIdentity: sameRepo
      })
    ).toBe(0)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{not json')
    simulateAppRestartForTests()
    expect(
      await restoreOrphanedChats(newRepo, {
        isLive: (id) => id === NEW,
        chatStore: () => chatStore(),
        readIdentity: sameRepo
      })
    ).toBe(0)
  })
})
