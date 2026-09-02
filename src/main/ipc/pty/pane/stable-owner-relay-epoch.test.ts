import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { toAppSshPtyId } from '../../../providers/ssh-pty-id'
import { rememberRetiredRelayEpochOwner, takeRetiredRelayEpochOwner } from './relay-pty-mint-epoch'
import { spawnForStablePane, type StablePaneOwner } from './stable-owner'

type EpochAwareSpawnOptions = PtySpawnOptions & { resumeProviderSession?: unknown }
type EpochAwareSpawnResult = PtySpawnResult & { agentResumeUnavailable?: true }

const owner = (relayPtyId: string): StablePaneOwner => ({
  tabId: 'tab-epoch-gate',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: toAppSshPtyId('remote', relayPtyId)
})

const agentSpawnOptions = (): EpochAwareSpawnOptions => ({
  cols: 100,
  rows: 30,
  cwd: '/workspace',
  env: { KEEP: 'yes', ORCA_AGENT_LAUNCH_TOKEN: 'launch-token' },
  envToDelete: ['DELETE_ME'],
  command: 'codex resume session',
  commandDelivery: 'provider',
  startupCommandDelivery: 'shell-ready',
  launchAgent: 'codex',
  resumeProviderSession: { key: 'session_id', id: 'session' },
  startupIngress: { colors: { foreground: '#ffffff' }, deadlineMs: 5_000 },
  agentSessionEnsure: {} as never,
  agentSessionCreateOperationId: 'create-operation'
})

function createProvider(status: unknown) {
  const spawns: EpochAwareSpawnOptions[] = []
  const requestHostRpc = vi.fn(async () => {
    if (status instanceof Error) {
      throw status
    }
    return status
  })
  const provider = {
    requestHostRpc,
    spawn: vi.fn(async (options: EpochAwareSpawnOptions) => {
      spawns.push(options)
      if (options.attachOnly) {
        throw new Error(`PTY "${options.sessionId}" not found`)
      }
      return { id: toAppSshPtyId('remote', 'pty2:current:2') }
    })
  } as unknown as IPtyProvider
  return { provider, requestHostRpc, spawns }
}

async function runSpawn(
  relayPtyId: string,
  status: unknown,
  spawnOptions: EpochAwareSpawnOptions = agentSpawnOptions()
) {
  const harness = createProvider(status)
  let freshResult: EpochAwareSpawnResult | undefined
  const spawned = await spawnForStablePane({
    runtime: undefined,
    provider: harness.provider,
    spawnOptions,
    owner: owner(relayPtyId),
    connectionId: 'remote',
    onFreshSpawn: (result) => {
      freshResult = result as EpochAwareSpawnResult
    }
  })
  return {
    ...harness,
    freshOptions: harness.spawns[1],
    result: spawned.result as EpochAwareSpawnResult,
    freshResult
  }
}

describe('spawnForStablePane relay epoch gate', () => {
  it('bounds retired owners when a pane never gets a fresh spawn', () => {
    for (let index = 0; index < 300; index += 1) {
      rememberRetiredRelayEpochOwner({
        connectionId: `connection-${index}`,
        paneKey: `pane-${index}`,
        ownerPtyId: `ssh:connection-${index}@@pty2:epoch-${index}:1`
      })
    }

    expect(takeRetiredRelayEpochOwner('connection-0', 'pane-0')).toBeUndefined()
    expect(takeRetiredRelayEpochOwner('connection-299', 'pane-299')).toBe(
      'ssh:connection-299@@pty2:epoch-299:1'
    )
  })

  it('refreshes eviction recency when the same pane retires again', () => {
    for (let index = 0; index < 512; index += 1) {
      rememberRetiredRelayEpochOwner({
        connectionId: `refresh-${index}`,
        paneKey: `pane-${index}`,
        ownerPtyId: `ssh:refresh-${index}@@pty2:epoch-${index}:1`
      })
    }
    // refresh-256 is now the oldest surviving entry; re-retiring it must move it to newest.
    rememberRetiredRelayEpochOwner({
      connectionId: 'refresh-256',
      paneKey: 'pane-256',
      ownerPtyId: 'ssh:refresh-256@@pty2:epoch-updated:1'
    })
    rememberRetiredRelayEpochOwner({
      connectionId: 'refresh-overflow',
      paneKey: 'pane-overflow',
      ownerPtyId: 'ssh:refresh-overflow@@pty2:epoch-overflow:1'
    })

    expect(takeRetiredRelayEpochOwner('refresh-257', 'pane-257')).toBeUndefined()
    expect(takeRetiredRelayEpochOwner('refresh-256', 'pane-256')).toBe(
      'ssh:refresh-256@@pty2:epoch-updated:1'
    )
  })

  it('declines an agent resume owned by a different relay epoch', async () => {
    const { freshOptions, result, freshResult, requestHostRpc } = await runSpawn(
      'pty2:previous:1',
      { ptyIdMintEpoch: 'current' }
    )

    expect(requestHostRpc).toHaveBeenCalledWith(
      'relay.status',
      {},
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(freshOptions).toMatchObject({
      cols: 100,
      rows: 30,
      cwd: '/workspace',
      env: { KEEP: 'yes' },
      envToDelete: expect.arrayContaining(['DELETE_ME', 'ORCA_AGENT_LAUNCH_TOKEN'])
    })
    expect(freshOptions).not.toHaveProperty('launchAgent')
    expect(freshOptions).not.toHaveProperty('command')
    expect(freshOptions).not.toHaveProperty('commandDelivery')
    expect(freshOptions).not.toHaveProperty('startupCommandDelivery')
    expect(freshOptions).not.toHaveProperty('resumeProviderSession')
    expect(freshOptions).not.toHaveProperty('startupIngress')
    expect(freshOptions).not.toHaveProperty('agentSessionEnsure')
    expect(freshOptions).not.toHaveProperty('agentSessionCreateOperationId')
    expect(result.agentResumeUnavailable).toBe(true)
    expect(freshResult?.agentResumeUnavailable).toBe(true)
  })

  it('preserves an agent resume owned by the current relay epoch', async () => {
    const spawnOptions = agentSpawnOptions()
    const { freshOptions, result } = await runSpawn('pty2:current:1', {
      ptyIdMintEpoch: 'current'
    })

    expect(freshOptions).toEqual(spawnOptions)
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it.each([
    ['legacy owner id', 'pty-1', { ptyIdMintEpoch: 'current' }],
    ['unknown relay epoch', 'pty2:previous:1', {}],
    ['relay status failure', 'pty2:previous:1', new Error('relay unavailable')]
  ])('preserves current behavior for %s', async (_label, relayPtyId, status) => {
    const spawnOptions = agentSpawnOptions()
    const { freshOptions, result } = await runSpawn(relayPtyId, status)

    expect(freshOptions).toEqual(spawnOptions)
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('decodes the epoch embedded in an app-facing SSH PTY id', async () => {
    const spawnOptions = agentSpawnOptions()
    const { freshOptions } = await runSpawn('pty2:relay%3Aepoch:1', {
      ptyIdMintEpoch: 'relay:epoch'
    })

    expect(freshOptions).toEqual(spawnOptions)
  })

  it('reads relay status only once per provider connection generation', async () => {
    const harness = createProvider({ ptyIdMintEpoch: 'current' })
    const spawn = () =>
      spawnForStablePane({
        runtime: undefined,
        provider: harness.provider,
        spawnOptions: agentSpawnOptions(),
        owner: owner('pty2:current:1'),
        connectionId: 'remote'
      })

    await Promise.all([spawn(), spawn()])
    expect(harness.requestHostRpc).toHaveBeenCalledOnce()
  })

  it('gates a resume after relay recovery retired the stable pane owner', async () => {
    const harness = createProvider({ ptyIdMintEpoch: 'current' })
    const paneKey = 'tab-retired-owner:22222222-2222-4222-8222-222222222222'
    rememberRetiredRelayEpochOwner({
      connectionId: 'remote',
      paneKey,
      ownerPtyId: toAppSshPtyId('remote', 'pty2:previous:1')
    })

    const spawned = await spawnForStablePane({
      runtime: undefined,
      provider: harness.provider,
      spawnOptions: agentSpawnOptions(),
      owner: null,
      connectionId: 'remote',
      paneKey
    })

    expect(harness.requestHostRpc).toHaveBeenCalledOnce()
    expect(harness.spawns[0]).not.toHaveProperty('resumeProviderSession')
    expect(spawned.result.agentResumeUnavailable).toBe(true)
  })

  it('preserves a resume after same-relay recovery retired the stable pane owner', async () => {
    const harness = createProvider({ ptyIdMintEpoch: 'current' })
    const paneKey = 'tab-current-owner:33333333-3333-4333-8333-333333333333'
    rememberRetiredRelayEpochOwner({
      connectionId: 'remote',
      paneKey,
      ownerPtyId: toAppSshPtyId('remote', 'pty2:current:1')
    })
    const spawnOptions = agentSpawnOptions()

    await spawnForStablePane({
      runtime: undefined,
      provider: harness.provider,
      spawnOptions,
      owner: null,
      connectionId: 'remote',
      paneKey
    })

    expect(harness.spawns[0]).toEqual(spawnOptions)
  })

  it('does not let a retired owner gate an unrelated later restore of the same pane', async () => {
    const paneKey = 'tab-lifetime:55555555-5555-4555-8555-555555555555'
    const retiredPtyId = toAppSshPtyId('remote', 'pty2:previous:1')
    const provider = {
      requestHostRpc: vi.fn(async () => ({ ptyIdMintEpoch: 'current' })),
      spawn: vi.fn(async (options: EpochAwareSpawnOptions) =>
        options.attachOnly
          ? { id: retiredPtyId, isReattach: true }
          : { id: toAppSshPtyId('remote', 'pty2:current:2') }
      )
    } as unknown as IPtyProvider
    rememberRetiredRelayEpochOwner({
      connectionId: 'remote',
      paneKey,
      ownerPtyId: retiredPtyId
    })

    await spawnForStablePane({
      runtime: undefined,
      provider,
      spawnOptions: { cols: 80, rows: 24 },
      owner: owner('pty2:previous:1'),
      connectionId: 'remote',
      paneKey
    })

    const secondOptions = agentSpawnOptions()
    await spawnForStablePane({
      runtime: undefined,
      provider,
      spawnOptions: secondOptions,
      owner: null,
      connectionId: 'remote',
      paneKey
    })
    expect(provider.spawn).toHaveBeenLastCalledWith(secondOptions)
  })

  it('retains the retired owner when the first replacement spawn fails', async () => {
    const paneKey = 'tab-retry:66666666-6666-4666-8666-666666666666'
    const requestHostRpc = vi.fn(async () => ({ ptyIdMintEpoch: 'current' }))
    let attempts = 0
    const provider = {
      requestHostRpc,
      spawn: vi.fn(async (options: EpochAwareSpawnOptions) => {
        if (options.attachOnly) {
          throw new Error('not found')
        }
        attempts += 1
        if (attempts === 1) {
          throw new Error('relay replacement in progress')
        }
        return { id: toAppSshPtyId('remote', 'pty2:current:2') }
      })
    } as unknown as IPtyProvider
    rememberRetiredRelayEpochOwner({
      connectionId: 'remote',
      paneKey,
      ownerPtyId: toAppSshPtyId('remote', 'pty2:previous:1')
    })

    await expect(
      spawnForStablePane({
        runtime: undefined,
        provider,
        spawnOptions: agentSpawnOptions(),
        owner: null,
        connectionId: 'remote',
        paneKey
      })
    ).rejects.toThrow('relay replacement in progress')

    const retried = await spawnForStablePane({
      runtime: undefined,
      provider,
      spawnOptions: agentSpawnOptions(),
      owner: null,
      connectionId: 'remote',
      paneKey
    })
    expect(retried.result.agentResumeUnavailable).toBe(true)
    expect(provider.spawn).toHaveBeenCalledTimes(2)
  })

  it('does not treat a new agent launch as a retired-owner resume', async () => {
    const harness = createProvider({ ptyIdMintEpoch: 'current' })
    const paneKey = 'tab-new-agent:44444444-4444-4444-8444-444444444444'
    rememberRetiredRelayEpochOwner({
      connectionId: 'remote',
      paneKey,
      ownerPtyId: toAppSshPtyId('remote', 'pty2:previous:1')
    })
    const spawnOptions: PtySpawnOptions = { cols: 80, rows: 24, launchAgent: 'claude' }

    await spawnForStablePane({
      runtime: undefined,
      provider: harness.provider,
      spawnOptions,
      owner: null,
      connectionId: 'remote',
      paneKey
    })

    expect(harness.requestHostRpc).not.toHaveBeenCalled()
    expect(harness.spawns[0]).toEqual(spawnOptions)
  })

  it('does not label a plain replacement shell as an unavailable agent resume', async () => {
    const { freshOptions, result } = await runSpawn(
      'pty2:previous:1',
      { ptyIdMintEpoch: 'current' },
      { cols: 80, rows: 24 }
    )

    expect(freshOptions).toEqual({ cols: 80, rows: 24 })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })
})
