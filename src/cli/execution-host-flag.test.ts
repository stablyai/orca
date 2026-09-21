import { describe, expect, it, vi } from 'vitest'

const { listEnvironmentsMock, resolveEnvironmentMock, getDefaultUserDataPathMock } = vi.hoisted(
  () => ({
    listEnvironmentsMock: vi.fn(),
    resolveEnvironmentMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  })
)

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('./runtime-client', () => ({
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

import {
  assertEnvironmentSelectorResolvable,
  hostFilterMatchesHostId,
  parseHostFlag,
  resolveHostFlagEnvironmentId
} from './execution-host-flag'
import { parseExecutionHostId } from '../shared/execution-host'

const listSshTargetsMock = vi.fn(async () => [] as { id: string; label: string }[])
const NO_SELECTION = {
  listSshTargets: listSshTargetsMock,
  pairingCode: null,
  environmentSelector: null
}

function flags(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

function environment(id: string, name = id) {
  return { id, name }
}

describe('parseHostFlag', () => {
  it('returns undefined when --host is absent', () => {
    expect(parseHostFlag(flags({}))).toBeUndefined()
  })

  it('rejects a --host flag with no value', () => {
    expect(() => parseHostFlag(flags({ host: true }))).toThrow('Missing value for --host')
  })

  it.each(['runtime:', 'ssh:', 'nonsense'])('rejects the unparseable host id %s', (value) => {
    expect(() => parseHostFlag(flags({ host: value }))).toThrow(`Invalid --host value: ${value}`)
  })

  it('parses the three supported host kinds', () => {
    expect(parseHostFlag(flags({ host: 'local' }))?.kind).toBe('local')
    expect(parseHostFlag(flags({ host: 'ssh:box-1' }))?.kind).toBe('ssh')
    expect(parseHostFlag(flags({ host: 'runtime:env-1' }))).toEqual({
      kind: 'runtime',
      id: 'runtime:env-1',
      environmentId: 'env-1'
    })
  })
})

describe('resolveHostFlagEnvironmentId', () => {
  it('keeps the current connection for local and ssh hosts', async () => {
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'local' }), NO_SELECTION)
    ).resolves.toBe(null)
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'ssh:box-1' }), NO_SELECTION)
    ).resolves.toBe(null)
    expect(listEnvironmentsMock).not.toHaveBeenCalled()
  })

  it('routes a paired runtime host to that environment', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), NO_SELECTION)
    ).resolves.toBe('env-1')
  })

  it('rejects a runtime host id that no paired environment owns', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-missing' }), NO_SELECTION)
    ).rejects.toThrow('no paired Orca server is named or has id env-missing')
  })

  // Why: the name is what a person or agent actually knows; requiring the raw uuid made the
  // obvious spelling fail against a server that is sitting right there.
  it('accepts the environment name as well as its id', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:gpu' }), NO_SELECTION)
    ).resolves.toBe('env-1')
  })

  it('decodes percent-encoded environment ids', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env one')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env%20one' }), NO_SELECTION)
    ).resolves.toBe('env one')
  })

  it('refuses a runtime host alongside --pairing-code', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), {
        listSshTargets: listSshTargetsMock,
        pairingCode: 'orca://pair?x',
        environmentSelector: null
      })
    ).rejects.toThrow('not both')
  })

  it('refuses a runtime host that disagrees with --environment', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1')])
    resolveEnvironmentMock.mockReturnValue(environment('env-2'))

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), {
        listSshTargets: listSshTargetsMock,
        pairingCode: null,
        environmentSelector: { value: 'other', label: '--environment' }
      })
    ).rejects.toThrow('name different Orca servers')
  })

  it('names the ambient variable when ORCA_ENVIRONMENT is the conflicting selector', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1')])
    resolveEnvironmentMock.mockReturnValue(environment('env-2'))

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), {
        listSshTargets: listSshTargetsMock,
        pairingCode: null,
        environmentSelector: { value: 'staging', label: 'ORCA_ENVIRONMENT' }
      })
    ).rejects.toThrow('ORCA_ENVIRONMENT staging name different Orca servers')
  })

  it('hands an agent the known environment ids to retry with', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:missing' }), NO_SELECTION)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: { knownEnvironments: [{ id: 'env-1', name: 'gpu' }] }
    })
  })

  it('accepts --environment naming the same server as the runtime host', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])
    resolveEnvironmentMock.mockReturnValue(environment('env-1', 'gpu'))

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), {
        listSshTargets: listSshTargetsMock,
        pairingCode: null,
        environmentSelector: { value: 'gpu', label: '--environment' }
      })
    ).resolves.toBe('env-1')
  })
})

describe('hostFilterMatchesHostId', () => {
  const runtimeHost = parseExecutionHostId('runtime:env-1')!
  const localHost = parseExecutionHostId('local')!
  const sshHost = parseExecutionHostId('ssh:box-1')!

  it('matches the identical host id', () => {
    expect(hostFilterMatchesHostId(runtimeHost, 'runtime:env-1')).toBe(true)
    expect(hostFilterMatchesHostId(localHost, 'local')).toBe(true)
    expect(hostFilterMatchesHostId(sshHost, 'ssh:box-1')).toBe(true)
  })

  it('treats the routed runtime own local rows as that runtime', () => {
    expect(hostFilterMatchesHostId(runtimeHost, 'local')).toBe(true)
  })

  it('does not widen local or ssh filters', () => {
    expect(hostFilterMatchesHostId(localHost, 'runtime:env-1')).toBe(false)
    expect(hostFilterMatchesHostId(sshHost, 'local')).toBe(false)
  })

  it('does not match a different runtime host', () => {
    expect(hostFilterMatchesHostId(runtimeHost, 'runtime:env-2')).toBe(false)
    expect(hostFilterMatchesHostId(runtimeHost, null)).toBe(false)
  })
})

describe('ambiguous environment names', () => {
  it('refuses --host runtime:<name> when two servers share that name', async () => {
    listEnvironmentsMock.mockReturnValue([
      environment('env-1', 'awin'),
      environment('env-2', 'awin')
    ])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:awin' }), NO_SELECTION)
    ).rejects.toThrow('2 paired servers are named awin')
  })

  it('refuses --environment <name> when two servers share that name', async () => {
    listEnvironmentsMock.mockReturnValue([
      environment('env-1', 'awin'),
      environment('env-2', 'awin')
    ])

    await expect(assertEnvironmentSelectorResolvable('awin', listSshTargetsMock)).rejects.toThrow(
      '2 paired servers are named awin'
    )
  })

  it('still routes an exact id past a colliding name', async () => {
    listEnvironmentsMock.mockReturnValue([
      environment('env-1', 'awin'),
      environment('env-2', 'awin')
    ])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-2' }), NO_SELECTION)
    ).resolves.toBe('env-2')
  })
})

describe('assertEnvironmentSelectorResolvable', () => {
  it('accepts a paired server by name or id', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    listSshTargetsMock.mockClear()

    await expect(
      assertEnvironmentSelectorResolvable('awin', listSshTargetsMock)
    ).resolves.toBeUndefined()
    await expect(
      assertEnvironmentSelectorResolvable('env-1', listSshTargetsMock)
    ).resolves.toBeUndefined()
    expect(listSshTargetsMock).not.toHaveBeenCalled()
  })

  // Why: the inverse of the --host case, and the one the report actually hit — a name that is
  // an SSH target dead-ended with a bare "unknown environment".
  it('names the SSH target when the selector is one', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    listSshTargetsMock.mockResolvedValue([{ id: 'ssh-1-a', label: 'openclaw' }])

    await expect(
      assertEnvironmentSelectorResolvable('openclaw', listSshTargetsMock)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: {
        nextSteps: expect.arrayContaining([expect.stringContaining('--host ssh:ssh-1-a')])
      }
    })
  })

  it('still points at host list when the name is on neither axis', async () => {
    listEnvironmentsMock.mockReturnValue([])
    listSshTargetsMock.mockResolvedValue([])

    await expect(
      assertEnvironmentSelectorResolvable('nowhere', listSshTargetsMock)
    ).rejects.toThrow('no paired Orca server is named or has id nowhere')
  })
})
