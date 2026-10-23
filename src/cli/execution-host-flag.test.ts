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
  resolveEnvironmentSelectorForStore,
  hostFilterMatchesHostId,
  parseHostFlag,
  resolveHostFlagEnvironmentId,
  resolveHostFlagTarget
} from './execution-host-flag'
import { parseExecutionHostId } from '../shared/execution-host'
import type { RuntimeClient } from './runtime-client'

const listSshTargetsMock = vi.fn(async () => [] as { id: string; label: string }[])
const NO_SELECTION = {
  listSshTargets: listSshTargetsMock,
  verifySshTargets: listSshTargetsMock,
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

  // A value that claims a kind but does not parse is malformed, not a name someone could have
  // meant — only an unprefixed value can be a host alias.
  it.each(['runtime:', 'ssh:', 'ssh:a|b', '   '])('rejects the unparseable host id %s', (value) => {
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

  // Why: `orca host list` prints the alias, so the alias is what gets typed. Rejecting it sent
  // people hunting for a machine-generated id the listing showed in a different column.
  it('carries an unprefixed host name through as an alias', () => {
    expect(parseHostFlag(flags({ host: 'trader-local' }))).toEqual({
      kind: 'alias',
      alias: 'trader-local'
    })
    expect(parseHostFlag(flags({ host: '  trader-local  ' }))).toEqual({
      kind: 'alias',
      alias: 'trader-local'
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
        verifySshTargets: listSshTargetsMock,
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
        verifySshTargets: listSshTargetsMock,
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
        verifySshTargets: listSshTargetsMock,
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

  it('accepts ORCA_ENVIRONMENT naming the runtime host in another case', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'Build')])
    resolveEnvironmentMock.mockImplementation(() => {
      throw new Error('Unknown environment: build')
    })

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), {
        listSshTargets: listSshTargetsMock,
        verifySshTargets: listSshTargetsMock,
        pairingCode: null,
        environmentSelector: { value: 'build', label: 'ORCA_ENVIRONMENT' }
      })
    ).resolves.toBe('env-1')
    resolveEnvironmentMock.mockReset()
  })

  it('accepts --environment naming the same server as the runtime host', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])
    resolveEnvironmentMock.mockReturnValue(environment('env-1', 'gpu'))

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'runtime:env-1' }), {
        listSshTargets: listSshTargetsMock,
        verifySshTargets: listSshTargetsMock,
        pairingCode: null,
        environmentSelector: { value: 'gpu', label: '--environment' }
      })
    ).resolves.toBe('env-1')
  })
})

// Why: the reported failure. `orca host list` shows `trader-local`, so `--host trader-local` is
// what gets typed, and only the machine-generated `ssh:ssh-1783599077486-fyasux` was accepted.
describe('unprefixed --host aliases', () => {
  function clientWithTargets(targets: { id: string; label: string }[]): RuntimeClient {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SSH target resolution reads only client.call.
    return {
      call: vi.fn(async () => ({ result: { targets } }))
    } as unknown as RuntimeClient
  }

  it('routes an alias that names a paired server to that environment', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])
    listSshTargetsMock.mockResolvedValue([])

    await expect(resolveHostFlagEnvironmentId(flags({ host: 'gpu' }), NO_SELECTION)).resolves.toBe(
      'env-1'
    )
  })

  // The SSH axis lives on the connected runtime, so a miss here is not yet a failure.
  it('leaves an alias that names no paired server to the SSH axis', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'trader-local' }), NO_SELECTION)
    ).resolves.toBe(null)
  })

  it('resolves an alias to the SSH target that carries that label', async () => {
    listEnvironmentsMock.mockReturnValue([])
    const client = clientWithTargets([{ id: 'ssh-1783599077486-fyasux', label: 'trader-local' }])

    await expect(resolveHostFlagTarget(flags({ host: 'trader-local' }), client)).resolves.toEqual({
      kind: 'ssh',
      id: 'ssh:ssh-1783599077486-fyasux',
      targetId: 'ssh-1783599077486-fyasux'
    })
  })

  it('names the alias the caller typed rather than an ssh: spelling they did not use', async () => {
    listEnvironmentsMock.mockReturnValue([])

    await expect(
      resolveHostFlagTarget(flags({ host: 'trader-local' }), clientWithTargets([]))
    ).rejects.toThrow('Unknown host in --host trader-local')
  })

  // Why: a paired server and an SSH target are different machines. Picking either would run the
  // command somewhere the caller never named.
  it('refuses an alias that names a machine on both axes', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    listSshTargetsMock.mockResolvedValue([{ id: 'ssh-1-a', label: 'awin' }])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'awin' }), NO_SELECTION)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining('--host runtime:env-1'),
          expect.stringContaining('--host ssh:ssh-1-a')
        ])
      }
    })
  })

  // Why: findSshTargetByName returns undefined for a duplicated label, which reads the same as
  // "no SSH target by that name" — so this case used to look conflict-free and resolve to the
  // paired server, the one direction that still guessed.
  it('refuses an alias naming a server and two SSH targets sharing a label', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    listSshTargetsMock.mockResolvedValue([
      { id: 'ssh-1-a', label: 'awin' },
      { id: 'ssh-2-b', label: 'awin' }
    ])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'awin' }), NO_SELECTION)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining('--host runtime:env-1'),
          expect.stringContaining('--host ssh:ssh-1-a'),
          expect.stringContaining('--host ssh:ssh-2-b')
        ])
      }
    })
  })

  it('refuses an alias two paired servers answer to', async () => {
    listEnvironmentsMock.mockReturnValue([
      environment('env-1', 'awin'),
      environment('env-2', 'awin')
    ])

    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'awin' }), NO_SELECTION)
    ).rejects.toThrow('Ambiguous Orca server in --host awin')
  })

  it('refuses to route an alias to a paired server when SSH targets cannot be read', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'awin' }), {
        ...NO_SELECTION,
        verifySshTargets: async () => {
          throw new Error('runtime unreachable')
        }
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('Cannot verify --host awin'),
      data: { nextSteps: [expect.stringContaining('--host runtime:env-1')] }
    })
  })

  // Why: `orca host list` prints `this machine` as the local row's name, with a space.
  it('resolves the local row name to --host local', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'This Machine' }), NO_SELECTION)
    ).resolves.toBe(null)
    await expect(
      resolveHostFlagTarget(flags({ host: 'this machine' }), clientWithTargets([]))
    ).resolves.toEqual({ kind: 'local', id: 'local' })
  })

  it('refuses the local row name when an SSH target carries it too', async () => {
    listEnvironmentsMock.mockReturnValue([])
    await expect(
      resolveHostFlagTarget(
        flags({ host: 'this machine' }),
        clientWithTargets([{ id: 'ssh-1-a', label: 'this machine' }])
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('Ambiguous --host this machine'),
      data: {
        nextSteps: expect.arrayContaining([
          'Use --host local for this machine.',
          expect.stringContaining('--host ssh:ssh-1-a')
        ])
      }
    })
  })

  it('refuses the local row name when a paired server carries it too', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'this machine')])
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'this machine' }), NO_SELECTION)
    ).rejects.toThrow('Ambiguous --host this machine')
  })

  it('resolves an SSH target label that contains spaces', async () => {
    listEnvironmentsMock.mockReturnValue([])
    const client = clientWithTargets([{ id: 'ssh-9', label: 'Build Box 2' }])
    await expect(resolveHostFlagTarget(flags({ host: 'build box 2' }), client)).resolves.toEqual({
      kind: 'ssh',
      id: 'ssh:ssh-9',
      targetId: 'ssh-9'
    })
  })

  // Why: cmd.exe does not strip single quotes, so `--host 'gpu'` arrives with them.
  it('ignores one pair of wrapping quotes around a host name', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'gpu')])
    listSshTargetsMock.mockResolvedValue([])
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: "'gpu'" }), NO_SELECTION)
    ).resolves.toBe('env-1')
    expect(parseHostFlag(flags({ host: '"local"' }))).toEqual({ kind: 'local', id: 'local' })
  })

  // Why: with --environment the command runs on that server, so a bare name is a machine it
  // reaches; a locally paired server sharing the name, even the routed one, is not a host there.
  it('leaves an alias to the routed server SSH targets when --environment picks the server', async () => {
    listEnvironmentsMock.mockReturnValue([
      environment('env-1', 'openclaw'),
      environment('env-2', 'omarchy')
    ])
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'omarchy' }), {
        ...NO_SELECTION,
        environmentSelector: { value: 'openclaw', label: '--environment' }
      })
    ).resolves.toBe(null)
    await expect(
      resolveHostFlagEnvironmentId(flags({ host: 'openclaw' }), {
        ...NO_SELECTION,
        environmentSelector: { value: 'openclaw', label: '--environment' }
      })
    ).resolves.toBe(null)
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

    await expect(resolveEnvironmentSelectorForStore('awin', listSshTargetsMock)).rejects.toThrow(
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

describe('resolveEnvironmentSelectorForStore', () => {
  it('accepts a paired server by name or id', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    listSshTargetsMock.mockClear()

    await expect(resolveEnvironmentSelectorForStore('awin', listSshTargetsMock)).resolves.toBe(
      'awin'
    )
    await expect(resolveEnvironmentSelectorForStore('env-1', listSshTargetsMock)).resolves.toBe(
      'env-1'
    )
    expect(listSshTargetsMock).not.toHaveBeenCalled()
  })

  // Why: the store matches names exactly, so a loosely matched name has to leave here as the id;
  // an exact one stays as typed, which `orca status` shows as the target.
  it('hands back the id for a name typed in another case or quoted', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'Build')])

    await expect(resolveEnvironmentSelectorForStore('build', listSshTargetsMock)).resolves.toBe(
      'env-1'
    )
    await expect(resolveEnvironmentSelectorForStore('"BUILD"', listSshTargetsMock)).resolves.toBe(
      'env-1'
    )
  })

  // Why: the inverse of the --host case, and the one the report actually hit — a name that is
  // an SSH target dead-ended with a bare "unknown environment".
  it('names the SSH target when the selector is one', async () => {
    listEnvironmentsMock.mockReturnValue([environment('env-1', 'awin')])
    listSshTargetsMock.mockResolvedValue([{ id: 'ssh-1-a', label: 'openclaw' }])

    await expect(
      resolveEnvironmentSelectorForStore('openclaw', listSshTargetsMock)
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

    await expect(resolveEnvironmentSelectorForStore('nowhere', listSshTargetsMock)).rejects.toThrow(
      'no paired Orca server is named or has id nowhere'
    )
  })
})
