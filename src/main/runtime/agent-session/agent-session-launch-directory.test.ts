import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { resolveAgentSessionLaunchDirectory } from './agent-session-launch-directory'
import type { AgentSessionRecordStore } from './records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from './records/agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from './ownership/agent-session-reservation-admission'

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
void {
  ...FLOATING,
  workspaceId: 'repo-1::/repos/one',
  workspaceKind: 'git-worktree'
}
void {
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
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('agent session launch directory', () => {
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
