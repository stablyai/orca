import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  AgentSessionWorkspaceMissingError,
  resolveAgentSessionLaunchDirectory
} from './agent-session-launch-directory'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const statFault = vi.hoisted(() => {
  const fault: { error: Error | null } = { error: null }
  return fault
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (statFault.error) {
        throw statFault.error
      }
      return actual.stat(...args)
    }
  }
})

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'

const FLOATING: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
  workspaceKind: 'folder'
}
const WORKTREE: AgentSessionExecutionLocation = {
  ...FLOATING,
  workspaceId: 'repo-1::/repos/one',
  workspaceKind: 'git-worktree'
}
const FOLDER: AgentSessionExecutionLocation = {
  ...FLOATING,
  workspaceId: 'folder:folder-1',
  workspaceKind: 'folder'
}

let root: string
let storeDirectory: string
let store: AgentSessionRecordStore

function reserveRequest(
  location: AgentSessionExecutionLocation,
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: SESSION,
    location,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'1'.padStart(32, '0')}`,
      fingerprint: 'fp-1'
    },
    now: NOW,
    ...overrides
  }
}

async function reserve(
  location: AgentSessionExecutionLocation,
  overrides: Partial<AgentSessionReserveRequest> = {}
) {
  return (await store.reserveOwner(reserveRequest(location, overrides))).record
}

async function directory(name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-launch-directory-'))
  storeDirectory = join(root, 'store')
  store = await AgentSessionRecordStore.open({ directory: storeDirectory, hostId: 'local' })
})

afterEach(async () => {
  statFault.error = null
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('agent session launch directory', () => {
  it('pins a new floating session to the directory its first launch used', async () => {
    const configured = await directory('floating-a')
    const record = await reserve(FLOATING)

    const cwd = await resolveAgentSessionLaunchDirectory(
      { store, resolveWorkspacePath: async () => configured },
      record
    )

    expect(cwd).toBe(configured)
    const reopened = await AgentSessionRecordStore.open({
      directory: storeDirectory,
      hostId: 'local'
    })
    expect(reopened.getRecord(SESSION)?.workspacePath).toBe(configured)
  })

  it('pins a new worktree session to the path its id resolved to', async () => {
    const record = await reserve(WORKTREE)

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async (id) => `/resolved/${id}` },
        record
      )
    ).resolves.toBe(`/resolved/${WORKTREE.workspaceId}`)
    expect(store.getRecord(SESSION)?.workspacePath).toBe(`/resolved/${WORKTREE.workspaceId}`)
  })

  it('resumes a floating session in its pinned folder after the floating setting changed', async () => {
    const original = await directory('floating-a')
    const changed = await directory('floating-b')
    const record = await reserve(FLOATING, { workspacePath: original })
    const resolveWorkspacePath = vi.fn(async () => changed)

    await expect(
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)
    ).resolves.toBe(original)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.workspacePath).toBe(original)
  })

  it('refuses a floating resume whose pinned folder is gone instead of substituting one', async () => {
    const gone = join(root, 'deleted-floating')
    const record = await reserve(FLOATING, { workspacePath: gone })
    const fallback = await directory('app-owned-floating')
    const resolveWorkspacePath = vi.fn(async () => fallback)

    const failure = resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)

    await expect(failure).rejects.toBeInstanceOf(AgentSessionWorkspaceMissingError)
    await expect(failure).rejects.toMatchObject({
      code: 'agent_session_operation_invalid',
      message: `The folder this chat ran in no longer exists: ${gone}. Restore it to continue.`
    })
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.workspacePath).toBe(gone)
  })

  it('refuses a floating resume whose pinned path is now a file', async () => {
    const file = join(root, 'not-a-folder')
    await writeFile(file, '')
    const record = await reserve(FLOATING, { workspacePath: file })

    await expect(
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath: async () => root }, record)
    ).rejects.toBeInstanceOf(AgentSessionWorkspaceMissingError)
  })

  it('reports a pinned folder it cannot read as that failure, not as a missing folder', async () => {
    const pinned = await directory('floating-locked')
    const record = await reserve(FLOATING, { workspacePath: pinned })
    const denied = Object.assign(new Error(`EACCES: permission denied, stat '${pinned}'`), {
      code: 'EACCES'
    })
    statFault.error = denied
    const resolveWorkspacePath = vi.fn(async () => root)

    const failure = resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)

    await expect(failure).rejects.toBe(denied)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
  })

  it('launches in the resolved directory when writing its pin fails', async () => {
    const configured = await directory('floating-a')
    const record = await reserve(FLOATING)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pinFailure = new Error('disk full')
    const pinWorkspacePath = vi.fn(async () => {
      throw pinFailure
    })

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store: { pinWorkspacePath }, resolveWorkspacePath: async () => configured },
        record
      )
    ).resolves.toBe(configured)
    expect(pinWorkspacePath).toHaveBeenCalledExactlyOnceWith(SESSION, configured)
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] launch directory pin failed',
      SESSION,
      pinFailure
    )
  })

  it.each([
    ['git worktree', WORKTREE],
    ['folder', FOLDER]
  ])('keeps resolving a %s resume by id, not by its pin', async (_kind, location) => {
    const record = await reserve(location, { workspacePath: '/where/it/first/ran' })

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async (id) => `/resolved/${id}` },
        record
      )
    ).resolves.toBe(`/resolved/${location.workspaceId}`)
    expect(store.getRecord(SESSION)?.workspacePath).toBe('/where/it/first/ran')
  })

  it('creates a replacement session already pinned to the folder it inherits', async () => {
    const inherited = await directory('floating-cleared')
    const record = await reserve(FLOATING, { workspacePath: inherited })
    expect(record.workspacePath).toBe(inherited)

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async () => '/floating/current-setting' },
        record
      )
    ).resolves.toBe(inherited)
  })

  it('pins a legacy floating record once, so a later setting change cannot move it', async () => {
    const current = await directory('floating-current')
    const later = await directory('floating-later')
    const legacy = await reserve(FLOATING)
    expect(legacy.workspacePath).toBeUndefined()

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async () => current },
        legacy
      )
    ).resolves.toBe(current)
    const pinned = store.getRecord(SESSION)
    expect(pinned?.workspacePath).toBe(current)
    if (!pinned) {
      throw new Error('the pinned record disappeared')
    }

    await expect(
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath: async () => later }, pinned)
    ).resolves.toBe(current)
  })
})
