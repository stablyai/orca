import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionClaimStatus,
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  JournalHostDatabase,
  journalDatabasePath
} from '../native-chat/agent-session-journal/journal-host-database'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
import {
  ensureStructuredAgentSessionHost,
  hasPersistedStructuredAgentSessionStore,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const HOST_ID = 'local'

function record(
  ownerProcess: AgentSessionProcessIdentity | null,
  lease: {
    processlessAt?: number | null
    reservedSpawnToken?: string | null
    claimStatus?: AgentSessionClaimStatus
    runtimeFence?: number
  } = {}
): AgentSessionRecord {
  return {
    sessionId: 'session-1',
    providerHandleChain: [],
    lease: {
      ownerProcess,
      reservedSpawnToken: null,
      claimStatus: 'released',
      runtimeFence: 3,
      ...lease
    }
  } as unknown as AgentSessionRecord
}

const OWNER: AgentSessionProcessIdentity = {
  hostId: HOST_ID,
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'token-1'
}

const deadProbe = () => vi.fn(async () => ({ outcome: 'pid-absent' }) as const)

describe('structured agent-session store presence', () => {
  let profile: string
  afterEach(async () => {
    if (profile) {
      await rm(profile, { recursive: true, force: true })
      profile = ''
    }
  })

  async function openProfileDatabase(): Promise<JournalHostDatabase> {
    profile = await mkdtemp(join(tmpdir(), 'orca-session-presence-'))
    return JournalHostDatabase.open(profile)
  }

  // Every host install creates the database, chats or not; startup restore must not wait on one.
  it('reports a profile whose database holds no chat absent', async () => {
    ;(await openProfileDatabase()).close()

    expect(hasPersistedStructuredAgentSessionStore(profile)).toBe(false)
  })

  it('reports a chat record in the database', async () => {
    const database = await openProfileDatabase()
    database.db
      .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
      .run('session-1', '{}')
    database.close()

    expect(hasPersistedStructuredAgentSessionStore(profile)).toBe(true)
  })

  it('reports a database it cannot read present', async () => {
    profile = await mkdtemp(join(tmpdir(), 'orca-session-presence-'))
    await writeFile(journalDatabasePath(profile), 'not a database')

    expect(hasPersistedStructuredAgentSessionStore(profile)).toBe(true)
  })

  it('reports a fresh profile absent after one presence check', () => {
    const fileExists = vi.fn(() => false)

    expect(hasPersistedStructuredAgentSessionStore('/profile', fileExists)).toBe(false)
    expect(fileExists).toHaveBeenCalledTimes(1)
  })
})

describe('structured agent-session owner probe', () => {
  it('probes an owner this host spawned', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe)(record(OWNER))

    expect(probe).toHaveBeenCalledWith({
      identity: OWNER,
      deps: { readEchoedSpawnToken: expect.any(Function) }
    })
    expect(result).toEqual({ outcome: 'pid-absent' })
  })

  it('reads the process table once for many local owners', async () => {
    const secondOwner = { ...OWNER, pid: 5252, spawnToken: 'token-2' }
    const probeMany = vi.fn(async () => [
      { outcome: 'identity-matched' as const, matchedOn: ['process-start-time' as const] },
      { outcome: 'pid-absent' as const }
    ])
    const probeOne = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'unused' }))
    const records = [
      record(OWNER),
      { ...record(secondOwner), sessionId: 'session-2' }
    ] as AgentSessionRecord[]

    const results = await createStructuredAgentSessionOwnerProbes(
      HOST_ID,
      probeMany,
      probeOne
    )(records)

    expect(probeMany).toHaveBeenCalledOnce()
    expect(probeMany).toHaveBeenCalledWith({
      identities: [OWNER, secondOwner],
      deps: { readEchoedSpawnToken: expect.any(Function) }
    })
    expect(probeOne).not.toHaveBeenCalled()
    expect(results.get('session-1')?.outcome).toBe('identity-matched')
    expect(results.get('session-2')).toEqual({ outcome: 'pid-absent' })
  })

  it('refuses to probe an owner on another host, whose pid means nothing here', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      probe
    )(record({ ...OWNER, hostId: 'ssh:build-box' }))

    expect(probe).not.toHaveBeenCalled()
    expect(result.outcome).toBe('indeterminate')
  })

  it('leaves a reservation whose spawn token is still live on this host latched', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe, async () => [9001])(
      record(null, { claimStatus: 'reserved', reservedSpawnToken: 'token-1' })
    )

    // Evicting here would put a second writer on a live Codex thread.
    expect(result.outcome).toBe('indeterminate')
  })

  it('leaves a reservation latched on a host that cannot enumerate spawn tokens', async () => {
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      deadProbe(),
      async () => null
    )(record(null, { claimStatus: 'reserved', reservedSpawnToken: 'token-1' }))

    expect(result.outcome).toBe('indeterminate')
  })

  it('frees a reservation once the host proves no process carries its token', async () => {
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      deadProbe(),
      async () => []
    )(record(null, { claimStatus: 'reserved', reservedSpawnToken: 'token-1' }))

    expect(result).toEqual({ outcome: 'reservation-unused' })
  })

  it('frees a lease that names neither an owner nor a spawn token', async () => {
    const probe = deadProbe()
    const scan = vi.fn(async () => [] as number[])
    // Nothing was ever minted that a child could be carrying, so no scan is even needed;
    // answering `indeterminate` here is what latches every released record into recovery.
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe, scan)(record(null))

    expect(probe).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'reservation-unused' })
  })

  it('still refuses a reservation that recorded no token to scan for', async () => {
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      deadProbe(),
      async () => []
    )(record(null, { claimStatus: 'reserved' }))

    expect(result.outcome).toBe('indeterminate')
  })
})

describe('structured agent-session runtime install', () => {
  let stateDirectory: string | null = null

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    if (stateDirectory) {
      await rm(stateDirectory, { recursive: true, force: true })
      stateDirectory = null
    }
    vi.restoreAllMocks()
  })

  it('holds stop until the model catalog has written its coalesced save', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-structured-runtime-'))
    await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory,
      hostId: HOST_ID,
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory!,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({})
    })
    let finishWrite = (): void => {}
    vi.spyOn(agentModelCatalogStore, 'flushPersistence').mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = resolve
      })
    )

    // Quit joins this stop to its teardown barrier; the unref'd coalesce timer never fires after it.
    let stopped = false
    const stop = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    finishWrite()
    await stop
    expect(stopped).toBe(true)
  })

  it('supports native Windows creation without the process-table addon', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-structured-runtime-'))
    const originalPlatform = process.platform
    const location: AgentSessionExecutionLocation = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    }
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => null)
    try {
      const host = await ensureStructuredAgentSessionHost({
        logger: createStructuredAgentSessionLogger(),
        stateDirectory,
        hostId: HOST_ID,
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => stateDirectory!,
        resolveEnvironment: async () => ({}),
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
        readProcessStartTime: async () => 1_700_000_000_000
      })

      // No addon means no creation times; chat no longer depends on them.
      expect(host.supportsCreate(location, 'codex')).toBe(true)
      expect(host.supportsCreate(location, 'claude')).toBe(true)
    } finally {
      __setWindowsProcessTreeLoaderForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
