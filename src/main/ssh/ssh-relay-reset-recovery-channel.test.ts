import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { parseSshRelayResetIntent } from './ssh-relay-reset-intent'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { RELAY_SENTINEL } from './relay-protocol'
import {
  buildSshResetPreparationReadCommand,
  buildSshResetRecoveryConnectCommand,
  openSshResetRecoveryChannel
} from './ssh-relay-reset-recovery-channel'

function intent(windows = false) {
  return parseSshRelayResetIntent({
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
    endpoint: windows
      ? {
          relayDir: 'C:\\Orca Data',
          runtimePath: 'C:\\Orca Data\\bun.exe',
          runtimeKind: 'bun',
          sockPath: '\\\\.\\pipe\\orca-reset',
          credentialFile: 'C:\\Orca Data\\credential',
          relayPlatform: 'win32-x64'
        }
      : {
          relayDir: '/orca data',
          runtimePath: '/orca data/bun',
          runtimeKind: 'bun',
          sockPath: '/orca data/socket',
          credentialFile: '/orca data/credential',
          relayPlatform: 'linux-x64'
        },
    request: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
}

function fixture() {
  const channel = Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true) }),
    close: vi.fn(),
    resume: vi.fn()
  })
  const saved = intent()
  const connection = {
    exec: vi.fn().mockResolvedValue(channel as unknown as ClientChannel),
    usesSystemSshTransport: vi.fn(() => false),
    getExecutionDestination: vi.fn(() => saved.destination),
    getTransportGeneration: vi.fn(() => 3)
  }
  const abort = new AbortController()
  const assertDestinationCurrent = vi.fn()
  const open = () =>
    openSshResetRecoveryChannel({
      intent: saved,
      connection,
      signal: abort.signal,
      assertDestinationCurrent
    })
  const ready = async () => {
    await vi.waitFor(() => expect(channel.listenerCount('data')).toBeGreaterThan(0))
    channel.emit('data', Buffer.from(RELAY_SENTINEL))
  }
  return { saved, channel, connection, abort, assertDestinationCurrent, open, ready }
}

it('uses only the recorded runtime and endpoint with no discovery or launch fallback', () => {
  expect(buildSshResetRecoveryConnectCommand(intent())).toBe(
    "cd '/orca data' && '/orca data/bun' relay.js --connect --sock-path '/orca data/socket' --credential-file '/orca data/credential'"
  )
})

it('uses literal Windows endpoint arguments and a native executable, without policy bypass', () => {
  const command = buildSshResetRecoveryConnectCommand(intent(true))
  expect(decodeRemotePowerShellScript(command)).toBe(
    "Set-Location -ErrorAction Stop -LiteralPath 'C:\\Orca Data'; & 'C:\\Orca Data\\bun.exe' 'relay.js' --connect --sock-path '\\\\.\\pipe\\orca-reset' --credential-file 'C:\\Orca Data\\credential'; exit $LASTEXITCODE"
  )
  expect(command).not.toContain('ExecutionPolicy')
})

it.each([false, true])('builds a negotiated read-only command, Windows=%s', (windows) => {
  const saved = intent(windows)
  const command = buildSshResetPreparationReadCommand({
    ...saved,
    preparation: {
      version: 1,
      readerVersion: 1,
      journalDirectory: windows ? 'C:\\Orca Data\\journal' : '/orca data/journal',
      principal: 'secret-principal',
      authenticationKind: 'endpoint-credential',
      sockPath: saved.endpoint.sockPath,
      serverBuildId: saved.serverBuildId
    }
  })
  const script = windows ? decodeRemotePowerShellScript(command) : command
  expect(script).toContain('--read-reset-preparation')
  expect(script).not.toContain('--connect')
  expect(script).not.toContain('secret-principal')
  expect(script).not.toContain('--credential-file')
  expect(script).not.toContain('ExecutionPolicy')
  if (windows) {
    expect(script).toContain('[System.Text.UTF8Encoding]::new($false)')
    expect(script).toContain('[Console]::In.ReadToEnd()')
    expect(script).toContain(
      "$OrcaResetInput | & 'C:\\Orca Data\\bun.exe' 'relay.js' --read-reset-preparation"
    )
    expect(script).toContain('exit $LASTEXITCODE')
  } else {
    expect(script).toBe("cd '/orca data' && '/orca data/bun' relay.js --read-reset-preparation")
  }
})

it('never invokes an unknown reader flag on an older host', () => {
  expect(() => buildSshResetPreparationReadCommand(intent())).toThrow('reader_unavailable')
})

it.each(['relayDir', 'runtimePath', 'sockPath', 'credentialFile'] as const)(
  'refuses unresolved %s rather than expanding a new endpoint',
  (field) => {
    const saved = intent()
    expect(() =>
      buildSshResetRecoveryConnectCommand({
        ...saved,
        endpoint: { ...saved.endpoint, [field]: '$HOME/relay' }
      })
    ).toThrow('not_absolute')
  }
)

it('does not load Windows script files as runtimes', () => {
  const saved = intent(true)
  expect(() =>
    buildSshResetRecoveryConnectCommand({
      ...saved,
      endpoint: { ...saved.endpoint, runtimePath: 'C:\\runtime.ps1' }
    })
  ).toThrow('not_executable')
})

it('opens one bridge and retains destination checks after the sentinel', async () => {
  const f = fixture()
  const pending = f.open()
  await f.ready()
  const result = await pending
  expect(f.connection.exec).toHaveBeenCalledTimes(1)
  expect(result.transport.sourceChannel).toBe(f.channel)
  expect(f.assertDestinationCurrent).toHaveBeenCalledTimes(3)
  f.assertDestinationCurrent.mockImplementation(() => {
    throw new Error('destination changed')
  })
  expect(result.assertCurrent).toThrow('destination changed')
  result.transport.close?.()
})

it('closes only its opened channel if destination changed during exec', async () => {
  const f = fixture()
  f.assertDestinationCurrent
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error('destination changed')
    })
  await expect(f.open()).rejects.toThrow('destination changed')
  expect(f.channel.close).toHaveBeenCalledTimes(1)
  expect(f.connection.exec).toHaveBeenCalledTimes(1)
})

it('closes the bridge when destination changed during handshake', async () => {
  const f = fixture()
  const pending = f.open()
  await vi.waitFor(() => expect(f.channel.listenerCount('data')).toBeGreaterThan(0))
  f.assertDestinationCurrent.mockImplementation(() => {
    throw new Error('destination changed')
  })
  f.channel.emit('data', Buffer.from(RELAY_SENTINEL))
  await expect(pending).rejects.toThrow('destination changed')
  expect(f.channel.close).toHaveBeenCalledTimes(1)
})

it('does not open a channel after cancellation', async () => {
  const f = fixture()
  f.abort.abort()
  await expect(f.open()).rejects.toThrow()
  expect(f.connection.exec).not.toHaveBeenCalled()
})

it.each(['missing-intent', 'missing-connection', 'mismatch', 'system'])(
  'refuses %s identity without trusting the caller assertion',
  async (kind) => {
    const f = fixture()
    if (kind === 'missing-connection') {
      f.connection.getExecutionDestination.mockReturnValue(undefined)
    }
    if (kind === 'mismatch') {
      f.connection.getExecutionDestination.mockReturnValue({
        ...f.saved.destination!,
        host: 'other'
      })
    }
    if (kind === 'system') {
      f.connection.usesSystemSshTransport.mockReturnValue(true)
    }
    await expect(
      openSshResetRecoveryChannel({
        intent: kind === 'missing-intent' ? { ...f.saved, destination: undefined } : f.saved,
        connection: f.connection,
        signal: f.abort.signal,
        assertDestinationCurrent: () => {}
      })
    ).rejects.toThrow('ssh_reset_recovery_destination_')
    expect(f.connection.exec).not.toHaveBeenCalled()
  }
)

it.each(['generation', 'destination'])(
  'closes its channel on %s drift during exec with a no-op caller',
  async (kind) => {
    const f = fixture()
    f.connection.exec.mockImplementation(async () => {
      if (kind === 'generation') {
        f.connection.getTransportGeneration.mockReturnValue(4)
      } else {
        f.connection.getExecutionDestination.mockReturnValue({ ...f.saved.destination! })
      }
      return f.channel as unknown as ClientChannel
    })
    await expect(f.open()).rejects.toThrow('ssh_reset_recovery_destination_changed')
    expect(f.channel.close).toHaveBeenCalledTimes(1)
  }
)

it.each(['generation', 'destination'])(
  'closes its bridge on %s drift during handshake with a no-op caller',
  async (kind) => {
    const f = fixture()
    const pending = f.open()
    await vi.waitFor(() => expect(f.channel.listenerCount('data')).toBeGreaterThan(0))
    if (kind === 'generation') {
      f.connection.getTransportGeneration.mockReturnValue(4)
    } else {
      f.connection.getExecutionDestination.mockReturnValue({ ...f.saved.destination! })
    }
    f.channel.emit('data', Buffer.from(RELAY_SENTINEL))
    await expect(pending).rejects.toThrow('ssh_reset_recovery_destination_changed')
    expect(f.channel.close).toHaveBeenCalledTimes(1)
  }
)

it('retains the transport fence after the handshake', async () => {
  const f = fixture()
  const pending = f.open()
  await f.ready()
  const result = await pending
  f.connection.getTransportGeneration.mockReturnValue(4)
  expect(result.assertCurrent).toThrow('ssh_reset_recovery_destination_changed')
  result.transport.close?.()
})

it('does not deploy, retry or replace an endpoint after connection failure', async () => {
  const f = fixture()
  f.connection.exec.mockRejectedValue(new Error('missing endpoint'))
  await expect(f.open()).rejects.toThrow('missing endpoint')
  expect(f.connection.exec).toHaveBeenCalledTimes(1)
  expect(f.channel.close).not.toHaveBeenCalled()
})
