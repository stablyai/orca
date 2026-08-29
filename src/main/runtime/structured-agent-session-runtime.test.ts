import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionClaimStatus,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes,
  ensureStructuredAgentSessionHost,
  hasPersistedStructuredAgentSessionStore,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

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
  it('stops after finding the durable primary store', () => {
    const fileExists = vi.fn(() => true)

    expect(hasPersistedStructuredAgentSessionStore('/profile', fileExists)).toBe(true)
    expect(fileExists).toHaveBeenCalledOnce()
    expect(fileExists).toHaveBeenCalledWith(
      join('/profile', 'agent-sessions', 'agent-sessions.json')
    )
  })

  it('checks the durable backup when the primary store is absent', () => {
    const fileExists = vi.fn((path: string) => path.endsWith('.bak'))

    expect(hasPersistedStructuredAgentSessionStore('/profile', fileExists)).toBe(true)
    expect(fileExists).toHaveBeenNthCalledWith(
      1,
      join('/profile', 'agent-sessions', 'agent-sessions.json')
    )
    expect(fileExists).toHaveBeenNthCalledWith(
      2,
      join('/profile', 'agent-sessions', 'agent-sessions.json.bak')
    )
  })

  it('reports a fresh profile absent after two bounded presence checks', () => {
    const fileExists = vi.fn(() => false)

    expect(hasPersistedStructuredAgentSessionStore('/profile', fileExists)).toBe(false)
    expect(fileExists).toHaveBeenCalledTimes(2)
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

  it('releases only a reservation carrying durable pre-spawn proof', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      probe
    )(record(null, { processlessAt: 1_800_000_000_000, claimStatus: 'reserved' }))

    expect(probe).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'reservation-unused' })
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

  it('starts orphan reaping and reports failures without failing installation', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-structured-runtime-'))
    const failure = new Error('scan failed')
    const reapOrphanChildren = vi.fn(async () => {
      throw failure
    })
    const onError = vi.fn()

    await expect(
      ensureStructuredAgentSessionHost({
        stateDirectory,
        hostId: HOST_ID,
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => stateDirectory!,
        resolveEnvironment: async () => ({}),
        reapOrphanChildren,
        onError
      })
    ).resolves.toBeDefined()

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith({
        scope: 'agent-session-orphan-child-reaper',
        error: failure
      })
    )
    expect(reapOrphanChildren).toHaveBeenCalledWith({ store: expect.anything() })
  })

  it('logs an orphan-reaper failure when no reporter is configured', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-structured-runtime-'))
    const failure = new Error('scan failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      ensureStructuredAgentSessionHost({
        stateDirectory,
        hostId: HOST_ID,
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => stateDirectory!,
        resolveEnvironment: async () => ({}),
        reapOrphanChildren: async () => {
          throw failure
        }
      })
    ).resolves.toBeDefined()

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[structured-agent-session] orphan reaper failed',
        failure
      )
    )
  })
})
