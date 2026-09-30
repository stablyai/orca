import { describe, expect, it, vi, beforeEach } from 'vitest'
import { clientInstances, resetSshConnectionMocks, ssh2Mock } from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

async function connectWithForwarding(): Promise<SshConnection> {
  vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
  vi.mocked(resolveWithSshG).mockResolvedValue(
    createResolvedConfig({ forwardAgent: true, proxyUseFdpass: false })
  )
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  return conn
}

describe('SshConnection agent forwarding requests', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('requests forwarding on every exec once granted', async () => {
    const conn = await connectWithForwarding()

    await conn.exec('first')
    await conn.exec('second')

    // ssh2 sends the request once per connection and short-circuits later asks.
    expect(clientInstances[0].execCalls.map((call) => call.agentForward)).toEqual([true, true])
  })

  it('does not request forwarding when OpenSSH config leaves it off', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ forwardAgent: false, proxyUseFdpass: false })
    )
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    await conn.exec('true')

    expect(clientInstances[0].execCalls.map((call) => call.agentForward)).toEqual([false])
  })

  it('keeps the connection usable when the server refuses forwarding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ssh2Mock.refuseAgentForwarding = true
    const conn = await connectWithForwarding()

    await expect(conn.exec('first')).resolves.toBeDefined()
    await expect(conn.exec('second')).resolves.toBeDefined()

    // The refused request never ran the command, so it is retried once without forwarding and
    // later execs stop asking — OpenSSH's warn-and-continue, not ssh2's fail-every-channel.
    expect(clientInstances[0].execCalls).toEqual([
      { cmd: expect.stringContaining('first'), agentForward: true },
      { cmd: expect.stringContaining('first'), agentForward: false },
      { cmd: expect.stringContaining('second'), agentForward: false }
    ])
    expect(warn.mock.calls.filter(([line]) => String(line).includes('refused agent'))).toHaveLength(
      1
    )
    warn.mockRestore()
  })

  it('starts each new client with a fresh request after a refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ssh2Mock.refuseAgentForwarding = true
    const conn = await connectWithForwarding()
    await conn.exec('first')
    await conn.exec('second')
    expect(clientInstances[0].execCalls.at(-1)?.agentForward).toBe(false)

    ssh2Mock.refuseAgentForwarding = false
    await conn.reconnect()
    await conn.exec('after-reconnect')

    expect(clientInstances.at(-1)?.execCalls.at(-1)?.agentForward).toBe(true)
  })
})
