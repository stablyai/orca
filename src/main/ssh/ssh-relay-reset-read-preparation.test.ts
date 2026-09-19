import { beforeEach, expect, it, vi } from 'vitest'
import { execCommand } from './ssh-relay-exec-command'
import type * as ExecCommandModule from './ssh-relay-exec-command'
import { parseSshRelayResetIntent } from './ssh-relay-reset-intent'
import { readSshResetPreparation } from './ssh-relay-reset-read-preparation'

vi.mock('./ssh-relay-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

function fixture() {
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: 'target',
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'client',
    serverBuildId: 'build',
    destination: {
      version: 1,
      transport: 'ssh2',
      host: 'execution.example',
      port: 22,
      username: 'orca',
      hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
      proxyRouteDigest: 'b'.repeat(64)
    },
    endpoint: {
      relayDir: '/orca data',
      runtimePath: '/orca data/bun',
      runtimeKind: 'bun',
      sockPath: '/orca data/socket',
      credentialFile: '/orca data/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'operation',
      runtimeIncarnation: 'incarnation',
      ownerGeneration: 1,
      ownerLease: 'secret-owner-lease'
    },
    preparation: {
      version: 1,
      readerVersion: 1,
      journalDirectory: '/orca data/journal',
      principal: 'secret-principal',
      authenticationKind: 'endpoint-credential',
      sockPath: '/orca data/socket',
      serverBuildId: 'build'
    }
  })
  const record = {
    version: 1,
    prepared: true,
    request: intent.request,
    principal: intent.preparation!.principal,
    authenticationKind: intent.preparation!.authenticationKind,
    sockPath: intent.endpoint.sockPath,
    serverBuildId: intent.serverBuildId
  }
  const abort = new AbortController()
  const assertDestinationCurrent = vi.fn()
  const connection = {
    exec: vi.fn(),
    usesSystemSshTransport: vi.fn(() => false),
    getExecutionDestination: vi.fn(() => intent.destination),
    getTransportGeneration: vi.fn(() => 3)
  }
  const read = () =>
    readSshResetPreparation({ intent, connection, signal: abort.signal, assertDestinationCurrent })
  vi.mocked(execCommand).mockImplementation(async (_connection, _command, options) => {
    options?.beforeInput?.()
    return JSON.stringify({ version: 1, preparation: record })
  })
  return { intent, record, abort, assertDestinationCurrent, connection, read }
}

beforeEach(() => {
  vi.mocked(execCommand).mockReset()
})

it('sends identity only on bounded stdin and retains the destination authority', async () => {
  const f = fixture()
  const result = await f.read()
  expect(result.preparation).toEqual(f.record)
  const [, command, options] = vi.mocked(execCommand).mock.calls[0]
  expect(command).toBe("cd '/orca data' && '/orca data/bun' relay.js --read-reset-preparation")
  expect(command).not.toContain('secret-')
  expect(JSON.parse(options!.stdin!)).toEqual({
    version: 1,
    binding: f.intent.preparation,
    request: f.intent.request
  })
  expect(options).toMatchObject({
    signal: f.abort.signal,
    timeoutMs: 15_000,
    maxOutputBytes: 65_536
  })
  expect(f.assertDestinationCurrent).toHaveBeenCalledTimes(4)
  f.assertDestinationCurrent.mockImplementation(() => {
    throw new Error('destination changed')
  })
  expect(result.assertCurrent).toThrow('destination changed')
})

it('refuses an unnegotiated reader before executing any command', async () => {
  const f = fixture()
  const { readerVersion: _version, ...preparation } = f.intent.preparation!
  await expect(
    readSshResetPreparation({
      intent: { ...f.intent, preparation },
      connection: f.connection,
      signal: f.abort.signal,
      assertDestinationCurrent: f.assertDestinationCurrent
    })
  ).rejects.toThrow('reader_unavailable')
  expect(execCommand).not.toHaveBeenCalled()
})

it('returns explicit missing evidence without inventing preparation', async () => {
  const f = fixture()
  vi.mocked(execCommand).mockResolvedValue('{"version":1,"preparation":null}')
  expect((await f.read()).preparation).toBeNull()
})

it.each(['missing-intent', 'missing-connection', 'mismatch', 'system'])(
  'a no-op caller cannot bypass %s destination evidence',
  async (kind) => {
    const f = fixture()
    if (kind === 'missing-connection') {
      f.connection.getExecutionDestination.mockReturnValue(undefined)
    }
    if (kind === 'mismatch') {
      f.connection.getExecutionDestination.mockReturnValue({
        ...f.intent.destination!,
        host: 'other'
      })
    }
    if (kind === 'system') {
      f.connection.usesSystemSshTransport.mockReturnValue(true)
    }
    await expect(
      readSshResetPreparation({
        intent: kind === 'missing-intent' ? { ...f.intent, destination: undefined } : f.intent,
        connection: f.connection,
        signal: f.abort.signal,
        assertDestinationCurrent: () => {}
      })
    ).rejects.toThrow('ssh_reset_recovery_destination_')
    expect(execCommand).not.toHaveBeenCalled()
  }
)

it.each(['generation', 'destination'])(
  'refuses %s drift before sending stdin even with a no-op caller',
  async (kind) => {
    const f = fixture()
    vi.mocked(execCommand).mockImplementation(async (_connection, _command, options) => {
      if (kind === 'generation') {
        f.connection.getTransportGeneration.mockReturnValue(4)
      } else {
        f.connection.getExecutionDestination.mockReturnValue({ ...f.intent.destination! })
      }
      options?.beforeInput?.()
      throw new Error('must not send input')
    })
    await expect(f.read()).rejects.toThrow('read_unverifiable')
  }
)

it.each(['generation', 'destination'])(
  'rejects otherwise valid preparation when %s changes during the read',
  async (kind) => {
    const f = fixture()
    vi.mocked(execCommand).mockImplementation(async (_connection, _command, options) => {
      options?.beforeInput?.()
      if (kind === 'generation') {
        f.connection.getTransportGeneration.mockReturnValue(4)
      } else {
        f.connection.getExecutionDestination.mockReturnValue({ ...f.intent.destination! })
      }
      return JSON.stringify({ version: 1, preparation: f.record })
    })
    await expect(f.read()).rejects.toThrow('ssh_reset_recovery_destination_changed')
  }
)

it('retains the transport fence after returning valid evidence', async () => {
  const f = fixture()
  const result = await f.read()
  f.connection.getTransportGeneration.mockReturnValue(4)
  expect(result.assertCurrent).toThrow('ssh_reset_recovery_destination_changed')
})

it.each([
  '',
  'null',
  '[]',
  '{}',
  '{"version":2,"preparation":null}',
  '{"version":1}',
  'secret-principal'
])('refuses malformed or incomplete reader output %s', async (output) => {
  const f = fixture()
  vi.mocked(execCommand).mockResolvedValue(output)
  await expect(f.read()).rejects.toThrow('read_invalid')
})

it.each(['principal', 'authenticationKind', 'sockPath', 'serverBuildId', 'request'] as const)(
  'requires exact %s evidence',
  async (field) => {
    const f = fixture()
    const other = {
      ...f.record,
      [field]:
        field === 'request'
          ? { ...f.record.request, ownerLease: 'other-lease' }
          : field === 'authenticationKind'
            ? 'launch-nonce'
            : 'different'
    }
    vi.mocked(execCommand).mockResolvedValue(JSON.stringify({ version: 1, preparation: other }))
    await expect(f.read()).rejects.toThrow('journal_conflict')
  }
)

it('refuses cancellation before opening a command', async () => {
  const f = fixture()
  f.abort.abort()
  await expect(f.read()).rejects.toThrow()
  expect(execCommand).not.toHaveBeenCalled()
})

it.each([1, 2, 3, 4])('refuses destination drift at authority check %s', async (check) => {
  const f = fixture()
  let checks = 0
  f.assertDestinationCurrent.mockImplementation(() => {
    if (++checks === check) {
      throw new Error('destination changed')
    }
  })
  await expect(f.read()).rejects.toThrow(check === 2 ? 'read_unverifiable' : 'destination changed')
  if (check === 1) {
    expect(execCommand).not.toHaveBeenCalled()
  }
})

it.each([false, true])(
  'redacts remote errors while preserving unconfirmed termination=%s',
  async (unconfirmed) => {
    const f = fixture()
    vi.mocked(execCommand).mockRejectedValue(
      Object.assign(
        new Error('stderr secret-owner-lease secret-principal'),
        unconfirmed ? { sshChannelCloseConfirmed: false } : {}
      )
    )
    const error = await f.read().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('ssh_reset_preparation_read_unverifiable')
    expect(error).not.toHaveProperty('cause')
    if (unconfirmed) {
      expect(error).toHaveProperty('sshChannelCloseConfirmed', false)
    } else {
      expect(error).not.toHaveProperty('sshChannelCloseConfirmed')
    }
  }
)
