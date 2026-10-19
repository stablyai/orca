import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { resolveAgentSessionLaunchDirectory } from './agent-session-launch-directory'
import { foundAgentSessionRecord } from './agent-session-record-founding'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
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
let store: AgentSessionRecordStore

const LAUNCH_FOLDER_MISSING = { name: 'AgentSessionPreSpawnError', reason: 'launchFolderMissing' }

function reserveRequest(location: AgentSessionExecutionLocation): AgentSessionReserveRequest {
  return {
    sessionId: SESSION,
    location,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
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
    now: NOW
  }
}

/** A session reserved at `location`, pinned to `launchDirectory` when one is given. */
async function reserve(location: AgentSessionExecutionLocation, launchDirectory?: string) {
  const { record } = await store.reserveOwner({
    ...reserveRequest(location),
    ...(launchDirectory ? { launchDirectory } : {})
  })
  return record
}

async function directory(name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-launch-directory-'))
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  statFault.error = null
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('agent session launch directory', () => {
  it('pins a new floating session to the directory its first launch used', async () => {
    const configured = await directory('floating-a')
    const record = await reserve(FLOATING, configured)
    const resolveWorkspacePath = vi.fn(() => directory('changed-setting'))

    const cwd = await resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)

    expect(cwd).toBe(configured)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    const reopened = await openTestAgentSessionRecordStore(root)
    expect(reopened.getRecord(SESSION)?.launchDirectory).toBe(configured)
  })

  it('resolves a worktree session by id without storing a second path', async () => {
    const record = await reserve(WORKTREE)

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async (id) => `/resolved/${id}` },
        record
      )
    ).resolves.toBe(`/resolved/${WORKTREE.workspaceId}`)
    expect(store.getRecord(SESSION)?.launchDirectory).toBeUndefined()
  })

  it('resumes a floating session in its pinned folder after the floating setting changed', async () => {
    const original = await directory('floating-a')
    const changed = await directory('floating-b')
    const record = await reserve(FLOATING, original)
    const resolveWorkspacePath = vi.fn(async () => changed)

    await expect(
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)
    ).resolves.toBe(original)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.launchDirectory).toBe(original)
  })

  it('refuses a floating resume whose pinned folder is gone instead of substituting one', async () => {
    const gone = join(root, 'deleted-floating')
    const record = await reserve(FLOATING, gone)
    const fallback = await directory('app-owned-floating')
    const resolveWorkspacePath = vi.fn(async () => fallback)

    const failure = resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)

    await expect(failure).rejects.toMatchObject(LAUNCH_FOLDER_MISSING)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.launchDirectory).toBe(gone)
  })

  it('refuses a floating resume whose pinned path is now a file', async () => {
    const file = join(root, 'not-a-folder')
    await writeFile(file, '')
    const record = await reserve(FLOATING, file)

    await expect(
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath: async () => root }, record)
    ).rejects.toMatchObject(LAUNCH_FOLDER_MISSING)
  })

  it('reports a pinned folder it cannot read as that failure, not as a missing folder', async () => {
    const pinned = await directory('floating-locked')
    const record = await reserve(FLOATING, pinned)
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
    const pinLaunchDirectory = vi.fn(async () => {
      throw pinFailure
    })

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store: { pinLaunchDirectory }, resolveWorkspacePath: async () => configured },
        record
      )
    ).resolves.toBe(configured)
    expect(pinLaunchDirectory).toHaveBeenCalledExactlyOnceWith(SESSION, configured)
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
    const record = await reserve(location, '/where/it/first/ran')

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async (id) => `/resolved/${id}` },
        record
      )
    ).resolves.toBe(`/resolved/${location.workspaceId}`)
    expect(store.getRecord(SESSION)?.launchDirectory).toBe('/where/it/first/ran')
  })

  it('founds a /clear replacement already pinned to the folder it inherits', async () => {
    const inherited = await directory('floating-cleared')
    const source = await reserve(FLOATING, inherited)
    const replacement = foundAgentSessionRecord(
      { ...source, sessionId: 'clear-replacement' },
      { claimKeyId: 'key-1', now: NOW }
    )
    expect(replacement.launchDirectory).toBe(inherited)

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async () => '/floating/current-setting' },
        replacement
      )
    ).resolves.toBe(inherited)
  })

  it('pins a legacy floating record once, so a later setting change cannot move it', async () => {
    const current = await directory('floating-current')
    const later = await directory('floating-later')
    const legacy = await reserve(FLOATING)
    expect(legacy.launchDirectory).toBeUndefined()

    await expect(
      resolveAgentSessionLaunchDirectory(
        { store, resolveWorkspacePath: async () => current },
        legacy
      )
    ).resolves.toBe(current)
    const pinned = store.getRecord(SESSION)
    expect(pinned?.launchDirectory).toBe(current)
    if (!pinned) {
      throw new Error('the pinned record disappeared')
    }

    await expect(
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath: async () => later }, pinned)
    ).resolves.toBe(current)
  })
})
