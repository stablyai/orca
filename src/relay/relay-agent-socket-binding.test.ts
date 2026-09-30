import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { agentLinkPathForRelaySocket, RelayAgentSocketBinding } from './relay-agent-socket-binding'

describe.skipIf(process.platform === 'win32')('RelayAgentSocketBinding', () => {
  let dir: string
  let linkPath: string
  let env: NodeJS.ProcessEnv
  let owners: Set<number>
  const servers: Server[] = []

  async function listenAgent(name: string): Promise<string> {
    const socketPath = path.join(dir, name)
    const server = createServer((sock) => sock.end(name))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return socketPath
  }

  function createBinding(uid?: number): RelayAgentSocketBinding {
    return new RelayAgentSocketBinding({
      linkPath,
      isSessionOwner: (clientId) => owners.has(clientId),
      env,
      ...(uid !== undefined ? { uid } : {})
    })
  }

  beforeEach(() => {
    // Resolved up front: macOS tmpdir is a symlink, and the binding links to resolved paths.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-bind-')))
    linkPath = agentLinkPathForRelaySocket(path.join(dir, 'relay-0123456789abcdef.sock'))
    env = { SSH_AUTH_SOCK: '/tmp/launch-session/agent.1' }
    owners = new Set()
  })

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('names the link like the relay socket so it fits the same sun_path budget', () => {
    const relaySock = path.join(dir, 'relay-0123456789abcdef.sock')
    expect(path.basename(linkPath)).toMatch(/^agent-[0-9a-f]{16}\.sock$/)
    expect(path.basename(linkPath)).toHaveLength(path.basename(relaySock).length)
    expect(path.dirname(linkPath)).toBe(dir)
  })

  it('drops the launch-time SSH_AUTH_SOCK and any stale link on start', () => {
    symlinkSync('/tmp/gone.sock', linkPath)
    createBinding().start()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(existsSync(linkPath)).toBe(false)
  })

  it('exports the link and points it at the bridge-reported socket', async () => {
    const agent = await listenAgent('agent-a.sock')
    const binding = createBinding()
    binding.start()

    binding.registerBridge(1, agent)

    expect(env.SSH_AUTH_SOCK).toBe(linkPath)
    expect(readlinkSync(linkPath)).toBe(agent)
    expect(binding.snapshot()).toMatchObject({ bound: true, bridgeRecords: 1 })
  })

  it('moves the same link to the newest bridge so existing shells follow reconnects', async () => {
    const first = await listenAgent('agent-a.sock')
    const second = await listenAgent('agent-b.sock')
    const binding = createBinding()
    binding.start()

    binding.registerBridge(1, first)
    binding.forgetClient(1)
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    binding.registerBridge(2, second)

    expect(env.SSH_AUTH_SOCK).toBe(linkPath)
    expect(readlinkSync(linkPath)).toBe(second)
  })

  it('falls back to an older live bridge when the newest one closes', async () => {
    const first = await listenAgent('agent-a.sock')
    const second = await listenAgent('agent-b.sock')
    const binding = createBinding()
    binding.start()
    binding.registerBridge(1, first)
    binding.registerBridge(2, second)

    binding.forgetClient(2)

    expect(readlinkSync(linkPath)).toBe(first)
  })

  it('never borrows an older connection agent when the newest connection forwards none', async () => {
    const first = await listenAgent('agent-a.sock')
    const binding = createBinding()
    binding.start()
    binding.registerBridge(1, first)

    binding.registerBridge(2, undefined)

    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(existsSync(linkPath)).toBe(false)
    expect(binding.snapshot().bound).toBe(false)
  })

  it('follows the PTY session owner over a newer non-owner bridge', async () => {
    const ownerAgent = await listenAgent('agent-owner.sock')
    const otherAgent = await listenAgent('agent-other.sock')
    const binding = createBinding()
    binding.start()
    binding.registerBridge(1, ownerAgent)
    binding.registerBridge(2, otherAgent)
    expect(readlinkSync(linkPath)).toBe(otherAgent)

    owners.add(1)
    binding.sessionOwnerChanged()

    expect(readlinkSync(linkPath)).toBe(ownerAgent)
    expect(binding.snapshot().boundClientIsOwner).toBe(true)
  })

  it.each([
    ['not-absolute', () => 'relative/agent.sock'],
    ['missing', () => path.join(dir, 'absent.sock')],
    [
      'not-socket',
      () => {
        const file = path.join(dir, 'plain-file')
        writeFileSync(file, '')
        return file
      }
    ],
    ['loop', () => linkPath]
  ] as const)('refuses a %s agent socket and leaves the agent unset', (reason, reported) => {
    const binding = createBinding()
    binding.start()

    binding.registerBridge(1, reported())

    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(binding.snapshot().lastRejectReason).toBe(reason)
  })

  it("refuses another user's socket", async () => {
    const agent = await listenAgent('agent-a.sock')
    const binding = createBinding((process.getuid?.() ?? 0) + 1)
    binding.start()

    binding.registerBridge(1, agent)

    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(binding.snapshot().lastRejectReason).toBe('uid-mismatch')
  })

  it('binds to the resolved socket when the bridge reports a symlink', async () => {
    const agent = await listenAgent('agent-a.sock')
    const alias = path.join(dir, 'alias.sock')
    symlinkSync(agent, alias)
    const binding = createBinding()
    binding.start()

    binding.registerBridge(1, alias)

    expect(readlinkSync(linkPath)).toBe(agent)
  })

  it('removes the link on dispose', async () => {
    const agent = await listenAgent('agent-a.sock')
    const binding = createBinding()
    binding.start()
    binding.registerBridge(1, agent)

    binding.dispose()

    expect(existsSync(linkPath)).toBe(false)
  })
})
