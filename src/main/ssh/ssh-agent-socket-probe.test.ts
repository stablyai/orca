import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOS from 'node:os'
import { join } from 'node:path'
import {
  _resetProbedAgentSocket,
  countAgentIdentities,
  getProbedAgentSocket,
  listAgentSocketCandidates,
  probePreferredAgentSocket
} from './ssh-agent-socket-probe'

// Why: isolate from the real 1Password agent socket that may exist (with real
// keys) in the developer's actual home directory.
const { homeDirState } = vi.hoisted(() => ({ homeDirState: { current: '' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>()
  return { ...actual, homedir: () => homeDirState.current }
})

// SSH agent wire: response = uint32 length, byte SSH_AGENT_IDENTITIES_ANSWER(12),
// uint32 nkeys, then per key: string blob, string comment.
function sshString(payload: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length)
  return Buffer.concat([len, payload])
}

function ed25519Blob(): Buffer {
  return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(Buffer.alloc(32, 7))])
}

function identitiesAnswer(keyCount: number): Buffer {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(keyCount)
  const keys: Buffer[] = []
  for (let i = 0; i < keyCount; i++) {
    keys.push(sshString(ed25519Blob()), sshString(Buffer.from(`key-${i}`)))
  }
  const body = Buffer.concat([Buffer.from([12]), count, ...keys])
  return Buffer.concat([sshString(body)])
}

type FakeAgent = { socketPath: string; server: Server; connections: Socket[] }

const fakeAgents: FakeAgent[] = []
let socketDir: string

function startFakeAgent(keyCount: number, opts: { hang?: boolean } = {}): Promise<FakeAgent> {
  return new Promise((resolve, reject) => {
    const socketPath = join(socketDir, `agent-${fakeAgents.length}.sock`)
    const connections: Socket[] = []
    const server = createServer((connection) => {
      connections.push(connection)
      if (opts.hang) {
        return
      }
      connection.on('data', () => connection.write(identitiesAnswer(keyCount)))
    })
    server.on('error', reject)
    server.listen(socketPath, () => {
      const agent = { socketPath, server, connections }
      fakeAgents.push(agent)
      resolve(agent)
    })
  })
}

describe('ssh-agent-socket-probe', () => {
  beforeEach(() => {
    _resetProbedAgentSocket()
    socketDir = mkdtempSync(join(tmpdir(), 'orca-agent-probe-'))
    homeDirState.current = socketDir
  })

  afterEach(async () => {
    await Promise.all(
      fakeAgents.splice(0).map((agent) => {
        // Why: a "hang" connection never drains, so close() would wait
        // forever for an 'end' that never fires — destroy first.
        agent.connections.forEach((connection) => connection.destroy())
        return new Promise<void>((resolve) => agent.server.close(() => resolve()))
      })
    )
    rmSync(socketDir, { recursive: true, force: true })
  })

  describe('listAgentSocketCandidates', () => {
    it('lists the env socket first when it exists on disk', async () => {
      const agent = await startFakeAgent(1)
      const candidates = listAgentSocketCandidates({ SSH_AUTH_SOCK: agent.socketPath })
      expect(candidates[0]).toBe(agent.socketPath)
    })

    it('skips a nonexistent env socket path', () => {
      const candidates = listAgentSocketCandidates({
        SSH_AUTH_SOCK: join(socketDir, 'missing.sock')
      })
      expect(candidates).not.toContain(join(socketDir, 'missing.sock'))
    })

    it('omits the env entry entirely when unset', () => {
      const candidates = listAgentSocketCandidates({})
      // Only the 1Password path may remain, and only if it exists on this machine.
      expect(candidates.every((candidate) => candidate.length > 0)).toBe(true)
    })
  })

  describe('countAgentIdentities', () => {
    it('returns the number of keys the agent reports', async () => {
      const agent = await startFakeAgent(2)
      expect(await countAgentIdentities(agent.socketPath)).toBe(2)
    })

    it('returns 0 for an agent with no keys', async () => {
      const agent = await startFakeAgent(0)
      expect(await countAgentIdentities(agent.socketPath)).toBe(0)
    })

    it('returns 0 when the agent never responds (timeout)', async () => {
      const agent = await startFakeAgent(0, { hang: true })
      expect(await countAgentIdentities(agent.socketPath, 100)).toBe(0)
    })

    it('returns 0 for a nonexistent socket', async () => {
      expect(await countAgentIdentities(join(socketDir, 'missing.sock'), 100)).toBe(0)
    })
  })

  describe('probePreferredAgentSocket', () => {
    const originalSock = process.env.SSH_AUTH_SOCK

    afterEach(() => {
      if (originalSock === undefined) {
        delete process.env.SSH_AUTH_SOCK
      } else {
        process.env.SSH_AUTH_SOCK = originalSock
      }
    })

    it('prefers the env socket when it has keys', async () => {
      const agent = await startFakeAgent(1)
      process.env.SSH_AUTH_SOCK = agent.socketPath
      expect(await probePreferredAgentSocket()).toBe(agent.socketPath)
      expect(getProbedAgentSocket()).toBe(agent.socketPath)
    })

    it('returns undefined when no candidate has keys', async () => {
      const empty = await startFakeAgent(0)
      process.env.SSH_AUTH_SOCK = empty.socketPath
      expect(await probePreferredAgentSocket()).toBeUndefined()
      expect(getProbedAgentSocket()).toBeUndefined()
    })

    it('clears previously probed state when a later probe finds nothing', async () => {
      const withKeys = await startFakeAgent(1)
      process.env.SSH_AUTH_SOCK = withKeys.socketPath
      await probePreferredAgentSocket()
      process.env.SSH_AUTH_SOCK = join(socketDir, 'missing.sock')
      await probePreferredAgentSocket()
      expect(getProbedAgentSocket()).toBeUndefined()
    })
  })
})
