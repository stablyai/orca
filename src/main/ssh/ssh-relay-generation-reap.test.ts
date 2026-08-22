import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false
}))
vi.mock('./ssh-relay-poll-delay', () => ({
  waitForRelayPollDelay: vi.fn().mockResolvedValue(undefined)
}))

import { readFileSync } from 'node:fs'
import { serializeRelayOwnerManifest } from '../../shared/relay-owner-manifest'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { waitForRelayPollDelay } from './ssh-relay-poll-delay'
import {
  RELAY_GENERATION_EXIT_BUDGET_MS,
  RELAY_GENERATION_EXIT_MAX_ATTEMPTS,
  isTerminalRelayGenerationRecoveryError,
  recoverFailedRelayReconnect
} from './ssh-relay-generation-reap'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const LINUX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const SOCK = '/home/user/.orca-remote/relay-0.1.0/relay-deadbeefdeadbeef.sock'
const GENERATION = 'a'.repeat(64)
const START = 'linux:8271934'
const SOCK_IDENTITY = '2049:999:1785948267'

const mockExec = vi.mocked(execCommand)
const conn = {} as SshConnection

type HostScript = {
  socketAlive?: string[]
  owner?: string
  identity?: string[]
  terminate?: string
  readiness?: string
  owners?: string[]
  lockCreate?: string[]
}

function ownerOutput(overrides?: {
  identity?: string
  sock?: string
  generation?: string
  /** Moves the manifest off the socket it is read against, which is what `superseded` means. */
  manifestIno?: number
}): string {
  const manifest = serializeRelayOwnerManifest({
    generation: overrides?.generation ?? GENERATION,
    pid: 4321,
    socketPath: overrides?.sock ?? SOCK,
    socketDev: 2049,
    socketIno: overrides?.manifestIno ?? 999,
    socketCtimeSeconds: 1785948267
  })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `m:${line}`)
    .join('\n')
  return `__ORCA_RELAY_OWNER__\nsockid=${overrides?.identity ?? SOCK_IDENTITY}\nmanifest=present\n${manifest}\n__ORCA_RELAY_OWNER_END__\n`
}

function identityOutput(state: string, start = START): string {
  return `__ORCA_RELAY_OWNER_ID__\nstate=${state}\nstart=${start}\n__ORCA_RELAY_OWNER_ID_END__\n`
}

function readinessOutput(state: string): string {
  return `__ORCA_RELAY_RELAUNCH_READY__\nready=${state}\n__ORCA_RELAY_RELAUNCH_READY_END__\n`
}

function probeOutput(sockid: string, manifest: string): string {
  return `__ORCA_RELAY_OWNER__\nsockid=${sockid}\nmanifest=${manifest}\n__ORCA_RELAY_OWNER_END__\n`
}

const commands: string[] = []

function installHost(script: HostScript): void {
  const queues = {
    socketAlive: [...(script.socketAlive ?? ['DEAD'])],
    identity: [...(script.identity ?? [])],
    owners: [...(script.owners ?? [])],
    lockCreate: [...(script.lockCreate ?? ['CREATED'])]
  }
  const next = (queue: string[], fallback: string): string =>
    queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? fallback)
  mockExec.mockImplementation((_conn, command: string) => {
    commands.push(command)
    // The claim+publish command is one exec that embeds mkdir, the steal and its own rm -rf, so it
    // must be matched before the release, which is the only other command naming the lock.
    if (command.includes('orca_claim=$(')) {
      return Promise.resolve(next(queues.lockCreate, 'CREATED'))
    }
    if (command.includes('.recovery-lock')) {
      return Promise.resolve('RELEASED')
    }
    if (command.includes('test -S')) {
      return Promise.resolve(next(queues.socketAlive, 'DEAD'))
    }
    if (command.includes('__ORCA_RELAY_RELAUNCH_READY__')) {
      return Promise.resolve(script.readiness ?? readinessOutput('absent'))
    }
    if (command.includes('kill -TERM')) {
      return Promise.resolve(script.terminate ?? identityOutput('signalled'))
    }
    if (command.includes('__ORCA_RELAY_OWNER_ID__')) {
      return Promise.resolve(next(queues.identity, identityOutput('gone', '')))
    }
    if (command.includes('__ORCA_RELAY_OWNER__')) {
      if (queues.owners.length > 0) {
        return Promise.resolve(next(queues.owners, ownerOutput()))
      }
      return Promise.resolve(script.owner ?? ownerOutput())
    }
    return Promise.resolve('')
  })
}

function termCommands(): string[] {
  return commands.filter((command) => command.includes('kill -TERM'))
}

function cleanupCommands(): string[] {
  return commands.filter((command) => command.includes('__ORCA_RELAY_RELAUNCH_READY__'))
}

function ownerProbes(): string[] {
  // The identity sentinel is __ORCA_RELAY_OWNER_ID__, so this substring selects only the probe.
  return commands.filter((command) => command.includes('__ORCA_RELAY_OWNER__'))
}

async function recover(overrides?: {
  reconnect?: () => Promise<string>
  relaunch?: () => Promise<string>
  signal?: AbortSignal
  host?: typeof LINUX
  sockPath?: string
}): ReturnType<typeof recoverFailedRelayReconnect<string>> {
  return recoverFailedRelayReconnect(conn, overrides?.host ?? LINUX, {
    sockPath: overrides?.sockPath ?? SOCK,
    signal: overrides?.signal,
    reconnect: overrides?.reconnect ?? (() => Promise.reject(new Error('still broken'))),
    relaunch: overrides?.relaunch ?? (() => Promise.resolve('relaunched'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  commands.length = 0
})

describe('recoverFailedRelayReconnect — proven generation', () => {
  it('terminates the owner once, confirms exit, cleans up, then relaunches once', async () => {
    installHost({ identity: [identityOutput('match'), identityOutput('gone', '')] })
    const relaunch = vi.fn().mockResolvedValue('fresh')

    await expect(recover({ relaunch })).resolves.toEqual({ status: 'relaunched', value: 'fresh' })

    expect(termCommands()).toHaveLength(1)
    expect(cleanupCommands()).toHaveLength(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('checks relaunch readiness only after the owner is confirmed gone', async () => {
    installHost({ identity: [identityOutput('match'), identityOutput('gone', '')] })
    await recover()
    const termIndex = commands.findIndex((command) => command.includes('kill -TERM'))
    const readyIndex = commands.findIndex((command) =>
      command.includes('__ORCA_RELAY_RELAUNCH_READY__')
    )
    expect(termIndex).toBeGreaterThanOrEqual(0)
    expect(readyIndex).toBeGreaterThan(termIndex)
  })

  it('issues no command that could remove the socket or its manifest', async () => {
    installHost({ identity: [identityOutput('match'), identityOutput('gone', '')] })
    await recover()
    // Why: recovery is read-only end to end. The recovery lock's own rm -rf is the sole exception,
    // and it never names the socket path.
    const destructive = commands.filter(
      (command) =>
        /\brm\b/.test(command) && command.includes(SOCK) && !command.includes('.recovery-lock')
    )
    expect(destructive).toEqual([])
  })

  it('threads the abort signal into every remote command except the lock release', async () => {
    installHost({ identity: [identityOutput('match'), identityOutput('gone', '')] })
    const signal = new AbortController().signal
    await recover({ signal })
    // The claim command embeds its own rm -rf, so the release is the lock command that is NOT the
    // claim.
    const isRelease = (command: string): boolean =>
      command.includes('.recovery-lock') && !command.includes('orca_claim=$(')
    const cancellable = mockExec.mock.calls.filter(([, command]) => !isRelease(command as string))
    expect(cancellable.length).toBeGreaterThan(4)
    for (const call of cancellable) {
      expect(call[2]).toMatchObject({ signal })
    }
    // Why: the release must outlive the abort that triggers it, so it is bounded by time instead.
    const release = mockExec.mock.calls.find(([, command]) => isRelease(command as string))
    expect(release?.[2]).toMatchObject({ timeoutMs: expect.any(Number) })
    // Why: the PR claims the signal reaches every new exec *and delay*; assert the delay too.
    for (const call of vi.mocked(waitForRelayPollDelay).mock.calls) {
      expect(call[1]).toBe(signal)
    }
  })

  it('waits longer than the relay needs to tear its own PTYs down', () => {
    // Why: relay.ts SIGTERM handling waits IMMEDIATE_PTY_EXIT_TIMEOUT_MS per PTY plus a force-kill
    // retry. Reading the relay's own source keeps this from drifting into "TERM sent, gave up early".
    const ptyHandler = readFileSync('src/relay/pty-handler.ts', 'utf8')
    const exitTimeout = Number(
      /IMMEDIATE_PTY_EXIT_TIMEOUT_MS = ([0-9_]+)/.exec(ptyHandler)?.[1].replace(/_/g, '')
    )
    const forceKillRetry = Number(
      /PTY_FORCE_KILL_RETRY_DELAY_MS = ([0-9_]+)/.exec(ptyHandler)?.[1].replace(/_/g, '')
    )
    expect(Number.isFinite(exitTimeout) && Number.isFinite(forceKillRetry)).toBe(true)
    expect(RELAY_GENERATION_EXIT_BUDGET_MS).toBeGreaterThan(exitTimeout + forceKillRetry)
  })

  it('skips the reap entirely when the socket vanished, then relaunches once', async () => {
    installHost({
      owner: '__ORCA_RELAY_OWNER__\nsockid=\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n'
    })
    const relaunch = vi.fn().mockResolvedValue('fresh')
    await expect(recover({ relaunch })).resolves.toEqual({ status: 'relaunched', value: 'fresh' })
    expect(termCommands()).toHaveLength(0)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})

describe('recoverFailedRelayReconnect — fail closed', () => {
  async function expectFailClosed(script: HostScript, reason: string): Promise<void> {
    installHost(script)
    const relaunch = vi.fn().mockResolvedValue('fresh')
    await expect(recover({ relaunch })).rejects.toMatchObject({
      name: 'RelayGenerationRecoveryError',
      reason
    })
    expect(relaunch).not.toHaveBeenCalled()
    expect(cleanupCommands()).toHaveLength(0)
  }

  it('never signals a legacy relay that published no manifest', async () => {
    await expectFailClosed(
      {
        owner: `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n`
      },
      'owner-unknown'
    )
    expect(termCommands()).toHaveLength(0)
  })

  it('never signals when the manifest is unusable', async () => {
    await expectFailClosed(
      {
        owner: `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=rejected\n__ORCA_RELAY_OWNER_END__\n`
      },
      'owner-unverifiable'
    )
    expect(termCommands()).toHaveLength(0)
  })

  it('never signals when a successor already rebound the socket', async () => {
    // Why owner-unverifiable and not a transition: this host reports the SAME identity on both
    // probes, so nothing is moving — see the transition matrix below for the split.
    await expectFailClosed(
      { owner: ownerOutput({ identity: '2049:1000:1785948267' }) },
      'owner-unverifiable'
    )
    expect(termCommands()).toHaveLength(0)
  })

  it('never signals when the probe output is unusable, and stays retryable', async () => {
    await expectFailClosed({ owner: 'garbage\n' }, 'owner-indeterminate')
    expect(termCommands()).toHaveLength(0)
    const err = await recover().catch((thrown: unknown) => thrown)
    expect(isTerminalRelayGenerationRecoveryError(err)).toBe(false)
  })

  it('never signals when argv no longer carries the generation token', async () => {
    await expectFailClosed({ identity: [identityOutput('mismatch', '')] }, 'identity-mismatch')
    expect(termCommands()).toHaveLength(0)
  })

  it('never signals when the process state cannot be determined', async () => {
    await expectFailClosed({ identity: [identityOutput('unknown', '')] }, 'identity-unverifiable')
    expect(termCommands()).toHaveLength(0)
  })

  it('does not clean up or relaunch when the terminate command reports a mismatch', async () => {
    await expectFailClosed(
      { identity: [identityOutput('match')], terminate: identityOutput('mismatch', '') },
      'identity-mismatch'
    )
    expect(termCommands()).toHaveLength(1)
  })

  it('does not clean up or relaunch when the terminate command fails', async () => {
    installHost({ identity: [identityOutput('match')] })
    const failing = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('kill -TERM')) {
        commands.push(command)
        return Promise.reject(new Error('remote kill failed'))
      }
      return (failing as NonNullable<typeof failing>)(c, command, options)
    })
    const relaunch = vi.fn()
    await expect(recover({ relaunch })).rejects.toMatchObject({ reason: 'termination-failed' })
    expect(relaunch).not.toHaveBeenCalled()
    expect(cleanupCommands()).toHaveLength(0)
  })

  it('does not clean up or relaunch when the owner survives the bounded wait', async () => {
    installHost({ identity: [identityOutput('match')] })
    const relaunch = vi.fn()
    await expect(recover({ relaunch })).rejects.toMatchObject({ reason: 'still-running' })
    expect(relaunch).not.toHaveBeenCalled()
    expect(cleanupCommands()).toHaveLength(0)
    const identityProbes = commands.filter(
      (command) => command.includes('__ORCA_RELAY_OWNER_ID__') && !command.includes('kill -TERM')
    )
    expect(identityProbes).toHaveLength(1 + RELAY_GENERATION_EXIT_MAX_ATTEMPTS)
  })

  it('does not relaunch while anything still occupies the socket path', async () => {
    installHost({
      identity: [identityOutput('match'), identityOutput('gone', '')],
      readiness: readinessOutput('present')
    })
    const relaunch = vi.fn()
    await expect(recover({ relaunch })).rejects.toMatchObject({ reason: 'relaunch-blocked' })
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('fails closed when the per-socket recovery lock cannot be acquired', async () => {
    installHost({ lockCreate: ['BUSY'] })
    const relaunch = vi.fn()
    await expect(recover({ relaunch })).rejects.toMatchObject({ reason: 'recovery-busy' })
    expect(termCommands()).toHaveLength(0)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it.each([
    ['the owner probe', '__ORCA_RELAY_OWNER__', 'probe-failed'],
    ['the recovery lock', 'orca_claim=$(', 'recovery-busy']
  ])('turns a transport failure during %s into a typed refusal', async (_label, marker, reason) => {
    installHost({ identity: [identityOutput('match'), identityOutput('gone', '')] })
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes(marker)) {
        return Promise.reject(new Error('ssh channel refused'))
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })
    const relaunch = vi.fn()
    await expect(recover({ relaunch })).rejects.toMatchObject({
      name: 'RelayGenerationRecoveryError',
      reason
    })
    expect(relaunch).not.toHaveBeenCalled()
    expect(termCommands()).toHaveLength(0)
  })

  it('does not swallow a relaunch failure into a second launch', async () => {
    installHost({ identity: [identityOutput('match'), identityOutput('gone', '')] })
    const relaunch = vi.fn().mockRejectedValue(new Error('Relay failed to start within 10s.'))
    await expect(recover({ relaunch })).rejects.toThrow(/failed to start/)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('marks an unprovable owner terminal so the message reaches the user', async () => {
    installHost({
      owner: `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n`
    })
    const unknownOwner = await recover().catch((err: unknown) => err)
    expect(isTerminalRelayGenerationRecoveryError(unknownOwner)).toBe(true)
  })

  it.each([
    ['a busy peer', { lockCreate: ['BUSY'] } as HostScript],
    ['a relay still draining', { identity: [identityOutput('match')] } as HostScript],
    [
      'a successor that took the socket',
      {
        identity: [identityOutput('match'), identityOutput('gone', '')],
        readiness: readinessOutput('present')
      } as HostScript
    ]
  ])('leaves %s retryable rather than parking the session', async (_label, script) => {
    // Why: these all resolve on a later attempt. Marking them terminal would cancel the reconnect
    // backoff and strand a session that a single retry would have recovered.
    commands.length = 0
    installHost(script)
    const err = await recover().catch((thrown: unknown) => thrown)
    expect(err).toBeInstanceOf(Error)
    expect(isTerminalRelayGenerationRecoveryError(err)).toBe(false)
  })

  it('leaves a transport fault during the owner probe retryable', async () => {
    installHost({})
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('__ORCA_RELAY_OWNER__')) {
        return Promise.reject(new Error('ssh channel refused'))
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })
    const err = await recover().catch((thrown: unknown) => thrown)
    expect(err).toMatchObject({ reason: 'probe-failed' })
    expect(isTerminalRelayGenerationRecoveryError(err)).toBe(false)
  })

  it('stops claiming the relay is untouched once SIGTERM has landed', async () => {
    installHost({ identity: [identityOutput('match')] })
    const survivor = await recover().catch((err: unknown) => err)
    expect((survivor as Error).message).not.toContain('untouched')
    expect((survivor as Error).message).toContain('did not remove the socket')
  })

  it('does not claim the relay is untouched when the terminate reply was lost', async () => {
    // Why: an exec timeout on the terminate command means the SIGTERM may well have landed and only
    // the reply was lost. Telling the user the PTYs are untouched would be a guess.
    installHost({ identity: [identityOutput('match')] })
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('kill -TERM')) {
        return Promise.reject(new Error('command timed out after 15s'))
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })
    const err = await recover().catch((thrown: unknown) => thrown)
    expect(err).toMatchObject({ reason: 'termination-failed' })
    expect((err as Error).message).not.toContain('untouched')
  })

  it('carries an actionable message naming the socket', async () => {
    installHost({
      owner: `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n`
    })
    await expect(recover()).rejects.toThrow(new RegExp(SOCK.replace(/[.]/g, '\\.')))
  })
})

describe('recoverFailedRelayReconnect — the two-read transition table', () => {
  const OTHER_SOCKET = '2049:1000:1785948267'
  // A manifest that names this path but describes a different socket object, read against the socket
  // the first probe saw: `manifest-superseded` without the socket itself having moved.
  const supersededHere = ownerOutput({ manifestIno: 1000 })
  // The same disagreement read against a socket that HAS moved.
  const supersededElsewhere = ownerOutput({ identity: OTHER_SOCKET })
  const noManifestHere = probeOutput(SOCK_IDENTITY, 'missing')

  // Why the identity queue: without it a wrongly-permitted signal would fail on a missing mock
  // instead of on the assertion. Scripted this way, any test that still reaches the reap runs it to
  // completion — one TERM, one relaunch — so the count assertions are what fail.
  function installTransition(owners: string[]): void {
    installHost({ owners, identity: [identityOutput('match'), identityOutput('gone', '')] })
  }

  async function expectRetryableTransition(owners: string[]): Promise<void> {
    installTransition(owners)
    const relaunch = vi.fn().mockResolvedValue('fresh')
    const err = await recover({ relaunch }).catch((thrown: unknown) => thrown)
    expect(err).toMatchObject({
      name: 'RelayGenerationRecoveryError',
      reason: 'owner-in-transition'
    })
    expect(isTerminalRelayGenerationRecoveryError(err)).toBe(false)
    expect(ownerProbes()).toHaveLength(2)
    expect(termCommands()).toHaveLength(0)
    expect(cleanupCommands()).toHaveLength(0)
    expect(relaunch).not.toHaveBeenCalled()
  }

  it.each([
    ['a missing manifest', noManifestHere],
    ['a superseded manifest', supersededHere]
  ])('refuses to signal a relay that published between the reads, after %s', async (_l, first) => {
    // Why: publication follows listen, so this transition proves a relay just completed startup.
    // It is a successor, and the whole point of #8585 is not to kill one.
    await expectRetryableTransition([first, ownerOutput()])
  })

  it.each([
    ['a manifest appearing', [noManifestHere, supersededHere]],
    ['a manifest disappearing', [supersededHere, noManifestHere]]
  ])('treats %s at an unchanged socket as movement, not a settled state', async (_l, owners) => {
    // Why not terminal: the probe answered differently twice, so nothing here is stable enough to
    // call stale. Only two identical reads may escalate.
    await expectRetryableTransition(owners)
  })

  it.each([
    ['no manifest on either read', [noManifestHere, probeOutput(OTHER_SOCKET, 'missing')]],
    ['a superseded manifest on either read', [supersededHere, supersededElsewhere]]
  ])('treats a socket rebound between the reads as movement, with %s', async (_l, owners) => {
    await expectRetryableTransition(owners)
  })

  it.each([
    ['no manifest at all', noManifestHere, 'owner-unknown'],
    ['a manifest that never describes this socket', supersededHere, 'owner-unverifiable']
  ])('keeps a stable %s terminal once the second read confirms it', async (_l, owner, reason) => {
    installTransition([owner, owner])
    const relaunch = vi.fn().mockResolvedValue('fresh')
    const err = await recover({ relaunch }).catch((thrown: unknown) => thrown)
    expect(err).toMatchObject({ reason })
    expect(isTerminalRelayGenerationRecoveryError(err)).toBe(true)
    expect(ownerProbes()).toHaveLength(2)
    expect(termCommands()).toHaveLength(0)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('proves the path empty rather than signalling when the socket vanishes between reads', async () => {
    // Why this one may proceed: the readiness command is non-mutating and refuses anything but an
    // empty pathname, so nothing is signalled and nothing is removed.
    installTransition([noManifestHere, probeOutput('', 'missing')])
    const relaunch = vi.fn().mockResolvedValue('fresh')
    await expect(recover({ relaunch })).resolves.toEqual({ status: 'relaunched', value: 'fresh' })
    expect(termCommands()).toHaveLength(0)
    expect(cleanupCommands()).toHaveLength(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a rejected manifest', probeOutput(SOCK_IDENTITY, 'rejected'), 'owner-unverifiable', true],
    ['an unparseable manifest', probeOutput(SOCK_IDENTITY, 'present'), 'owner-unverifiable', true],
    [
      'a manifest for another path',
      ownerOutput({ sock: '/tmp/other.sock' }),
      'owner-unverifiable',
      true
    ],
    ['a non-socket at the path', probeOutput('unusable', 'missing'), 'endpoint-unusable', true],
    ['an unreadable socket', probeOutput('unreadable', 'missing'), 'owner-indeterminate', false],
    ['output it cannot read', 'garbage\n', 'owner-indeterminate', false]
  ])(
    'keeps %s fail-closed when it follows a transitional read',
    async (_l, second, reason, terminal) => {
      installTransition([noManifestHere, second])
      const relaunch = vi.fn().mockResolvedValue('fresh')
      const err = await recover({ relaunch }).catch((thrown: unknown) => thrown)
      expect(err).toMatchObject({ reason })
      expect(isTerminalRelayGenerationRecoveryError(err)).toBe(terminal)
      expect(termCommands()).toHaveLength(0)
      expect(cleanupCommands()).toHaveLength(0)
      expect(relaunch).not.toHaveBeenCalled()
    }
  )

  it('never turns a second read into permission to signal, whatever it says', async () => {
    // The invariant behind every case above: once one read found the path unowned, this recovery
    // attempt is over. A healthy relay is reclaimed by the next reconnect, not by this reap.
    for (const second of [ownerOutput(), supersededHere, supersededElsewhere, noManifestHere]) {
      commands.length = 0
      installTransition([noManifestHere, second])
      await recover({ relaunch: () => Promise.resolve('fresh') }).catch(() => undefined)
      expect(termCommands()).toHaveLength(0)
    }
  })
})

describe('recoverFailedRelayReconnect — serialization and abort', () => {
  it('skips the reconnect retry when the lock was uncontended', async () => {
    installHost({
      socketAlive: ['ALIVE'],
      identity: [identityOutput('match'), identityOutput('gone', '')]
    })
    const reconnect = vi.fn().mockResolvedValue('reused')
    await expect(recover({ reconnect })).resolves.toMatchObject({ status: 'relaunched' })
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('re-probes after waiting for the lock and reconnects when a peer already recovered', async () => {
    installHost({
      lockCreate: ['BUSY', 'CREATED'],
      socketAlive: ['ALIVE'],
      identity: [identityOutput('match')]
    })
    const relaunch = vi.fn()
    await expect(
      recover({ relaunch, reconnect: () => Promise.resolve('reused') })
    ).resolves.toEqual({ status: 'reconnected', value: 'reused' })
    expect(termCommands()).toHaveLength(0)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('serializes two concurrent callers into one termination and one relaunch', async () => {
    let lockHeld = false
    let recovered = false
    const relaunch = vi.fn().mockImplementation(() => {
      recovered = true
      return Promise.resolve('fresh')
    })
    const identityQueue = [identityOutput('match'), identityOutput('gone', '')]
    mockExec.mockImplementation((_conn, command: string) => {
      commands.push(command)
      if (command.includes('orca_claim=$(')) {
        if (lockHeld) {
          return Promise.resolve('BUSY')
        }
        lockHeld = true
        return Promise.resolve('CREATED')
      }
      if (command.includes('.recovery-lock')) {
        lockHeld = false
        return Promise.resolve('RELEASED')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(recovered ? 'ALIVE' : 'DEAD')
      }
      if (command.includes('__ORCA_RELAY_RELAUNCH_READY__')) {
        return Promise.resolve(readinessOutput('absent'))
      }
      if (command.includes('kill -TERM')) {
        return Promise.resolve(identityOutput('signalled'))
      }
      if (command.includes('__ORCA_RELAY_OWNER_ID__')) {
        return Promise.resolve(identityQueue.shift() ?? identityOutput('gone', ''))
      }
      if (command.includes('__ORCA_RELAY_OWNER__')) {
        return Promise.resolve(ownerOutput())
      }
      return Promise.resolve('')
    })

    const results = await Promise.all([
      recover({ relaunch }),
      recover({ relaunch, reconnect: () => Promise.resolve('reused') })
    ])

    expect(termCommands()).toHaveLength(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(results.filter((result) => result.status === 'relaunched')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'reconnected')).toHaveLength(1)
  })

  it('rethrows an abort raised while waiting for the owner to exit', async () => {
    const controller = new AbortController()
    installHost({ identity: [identityOutput('match')] })
    const failing = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('kill -TERM')) {
        controller.abort()
      }
      return (failing as NonNullable<typeof failing>)(c, command, options)
    })
    await expect(recover({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('releases the recovery lock with its own budget after an abort', async () => {
    const controller = new AbortController()
    installHost({ identity: [identityOutput('match')] })
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('kill -TERM')) {
        controller.abort()
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })

    await expect(recover({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })

    // Why: passing the aborted signal here would make execCommand refuse and leak the lock until
    // the staleness window expires, locking the user out of their own relay.
    const release = mockExec.mock.calls.find(
      ([, command]) =>
        (command as string).includes('.recovery-lock') &&
        !(command as string).includes('orca_claim=$(')
    )
    expect(release).toBeDefined()
    expect((release as unknown[])[2]).toMatchObject({ timeoutMs: expect.any(Number) })
    expect((release as unknown[])[2]).not.toHaveProperty('signal', controller.signal)
  })

  it('rethrows an unconfirmed SSH termination instead of failing closed silently', async () => {
    const unconfirmed = Object.assign(new Error('channel close unconfirmed'), {
      sshChannelCloseConfirmed: false
    })
    installHost({})
    const failing = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('__ORCA_RELAY_OWNER__')) {
        return Promise.reject(unconfirmed)
      }
      return (failing as NonNullable<typeof failing>)(c, command, options)
    })
    await expect(recover()).rejects.toBe(unconfirmed)
  })
})

describe('recoverFailedRelayReconnect — Windows', () => {
  it('reports named pipe hosts as unsupported without running any command', async () => {
    installHost({})
    await expect(
      recover({ host: WINDOWS, sockPath: '\\\\.\\pipe\\orca-relay-abc' })
    ).resolves.toEqual({ status: 'unsupported' })
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('reports a Windows host as unsupported even for a POSIX-shaped socket path', async () => {
    // Why: both current cases pass a pipe path, so the isWindowsRemoteHost disjunct alone was
    // untested and could be deleted without any test noticing.
    installHost({})
    const relaunch = vi.fn()
    const reconnect = vi.fn()
    await expect(recover({ host: WINDOWS, relaunch, reconnect })).resolves.toEqual({
      status: 'unsupported'
    })
    expect(mockExec).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('reports a named pipe path on a POSIX host as unsupported', async () => {
    installHost({})
    await expect(recover({ sockPath: '\\\\.\\pipe\\orca-relay-abc' })).resolves.toEqual({
      status: 'unsupported'
    })
    expect(mockExec).not.toHaveBeenCalled()
  })
})
