import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import {
  __resetCoLocationCacheForTests,
  collectHostAddresses,
  endpointHostname,
  findCoLocatedEnvironmentIds,
  matchCoLocatedEnvironments,
  normalizeHostAddress
} from './ssh-target-environment-colocation'

function target(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-mini',
    label: 'vaish@mini',
    host: '100.71.10.60',
    port: 22,
    username: 'vaish',
    ...overrides
  }
}

function environment(
  endpoint: string,
  overrides: Partial<KnownRuntimeEnvironment> = {}
): KnownRuntimeEnvironment {
  return {
    id: 'env-mini',
    name: 'mini',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: 'ws-env-mini',
        kind: 'websocket',
        label: 'mini',
        endpoint,
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    preferredEndpointId: 'ws-env-mini',
    ...overrides
  }
}

const noLookup = vi.fn(async () => [] as string[])
const noAlias = vi.fn(async () => null)

describe('host address normalisation', () => {
  it('reads the hostname out of a websocket endpoint', () => {
    expect(endpointHostname('ws://100.71.10.60:6768')).toBe('100.71.10.60')
    expect(endpointHostname('wss://Mini.TailC9CD08.ts.net./')).toBe('mini.tailc9cd08.ts.net')
    expect(endpointHostname('ws://[fd7a::1]:6768')).toBe('fd7a::1')
    expect(endpointHostname('not a url')).toBeNull()
  })

  it('treats case, trailing dots and IPv6 brackets as the same host', () => {
    expect(normalizeHostAddress(' Mini.Local. ')).toBe('mini.local')
    expect(normalizeHostAddress('[::1]')).toBe('::1')
  })

  it('refuses to describe a loopback endpoint as any remote host', async () => {
    const lookup = vi.fn(async () => ['127.0.0.1'])
    expect(await collectHostAddresses(['localhost'], lookup)).toEqual(new Set())
    expect(await collectHostAddresses(['127.0.0.1'], lookup)).toEqual(new Set())
    expect(lookup).not.toHaveBeenCalled()
  })

  it('joins names with their resolved addresses', async () => {
    const lookup = vi.fn(async (host: string) =>
      host === 'mini.local' ? ['192.168.1.20', 'fe80::1'] : []
    )
    expect(await collectHostAddresses(['mini.local'], lookup)).toEqual(
      new Set(['mini.local', '192.168.1.20', 'fe80::1'])
    )
  })
})

describe('matchCoLocatedEnvironments', () => {
  it('pairs a target with the first server sharing an address', () => {
    const matches = matchCoLocatedEnvironments(
      [
        { id: 'ssh-a', addresses: new Set(['10.0.0.5']) },
        { id: 'ssh-b', addresses: new Set(['10.0.0.9']) }
      ],
      [
        { id: 'env-x', addresses: new Set(['10.0.0.7']) },
        { id: 'env-y', addresses: new Set(['10.0.0.5', '10.0.0.6']) }
      ]
    )
    expect([...matches]).toEqual([['ssh-a', 'env-y']])
  })

  it('never matches on an empty address set', () => {
    expect(
      matchCoLocatedEnvironments(
        [{ id: 'ssh-a', addresses: new Set() }],
        [{ id: 'env-x', addresses: new Set() }]
      ).size
    ).toBe(0)
  })
})

describe('findCoLocatedEnvironmentIds', () => {
  beforeEach(() => {
    __resetCoLocationCacheForTests()
    noLookup.mockClear()
    noAlias.mockClear()
  })

  it('matches an SSH target and a paired server on the same tailnet IP', async () => {
    const matches = await findCoLocatedEnvironmentIds(
      [target()],
      [environment('ws://100.71.10.60:6768')],
      { lookup: noLookup, resolveAlias: noAlias }
    )
    expect([...matches]).toEqual([['ssh-mini', 'env-mini']])
  })

  // The target was imported from ~/.ssh/config as `Host mini`; only `ssh -G` knows its address.
  it('resolves an OpenSSH alias before comparing', async () => {
    const resolveAlias = vi.fn(async (alias: string) => (alias === 'mini' ? '100.71.10.60' : null))
    const matches = await findCoLocatedEnvironmentIds(
      [target({ host: 'mini', configHost: 'mini' })],
      [environment('ws://100.71.10.60:6768')],
      { lookup: noLookup, resolveAlias }
    )
    expect(matches.get('ssh-mini')).toBe('env-mini')
    expect(resolveAlias).toHaveBeenCalledWith('mini')
  })

  it('matches a MagicDNS endpoint against an IP target through DNS', async () => {
    const lookup = vi.fn(async (host: string) =>
      host === 'mini.tailc9cd08.ts.net' ? ['100.71.10.60'] : []
    )
    const matches = await findCoLocatedEnvironmentIds(
      [target()],
      [environment('ws://mini.tailc9cd08.ts.net:6768')],
      { lookup, resolveAlias: noAlias }
    )
    expect(matches.get('ssh-mini')).toBe('env-mini')
  })

  it('does not pair an SSH-tunnelled server on localhost with any target', async () => {
    const matches = await findCoLocatedEnvironmentIds(
      [target({ host: 'localhost' })],
      [environment('ws://127.0.0.1:6768', { connectionDependency: 'ssh-tunnel' })],
      { lookup: noLookup, resolveAlias: noAlias }
    )
    expect(matches.size).toBe(0)
  })

  it('answers repeat calls from the cache while the inputs are unchanged', async () => {
    const deps = { lookup: noLookup, resolveAlias: noAlias }
    const targets = [target()]
    const environments = [environment('ws://100.71.10.60:6768')]
    await findCoLocatedEnvironmentIds(targets, environments, deps, 1_000)
    await findCoLocatedEnvironmentIds(targets, environments, deps, 2_000)
    expect(noLookup).toHaveBeenCalledTimes(2)

    await findCoLocatedEnvironmentIds([target({ host: '100.71.10.61' })], environments, deps, 3_000)
    expect(noLookup).toHaveBeenCalledTimes(4)
  })

  it('skips the work entirely when either side is empty', async () => {
    expect(
      (
        await findCoLocatedEnvironmentIds([], [environment('ws://x:1')], {
          lookup: noLookup,
          resolveAlias: noAlias
        })
      ).size
    ).toBe(0)
    expect(
      (
        await findCoLocatedEnvironmentIds([target()], [], {
          lookup: noLookup,
          resolveAlias: noAlias
        })
      ).size
    ).toBe(0)
    expect(noLookup).not.toHaveBeenCalled()
  })
})
