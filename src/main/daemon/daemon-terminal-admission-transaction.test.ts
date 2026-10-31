import './mock-descendant-sweep'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sendDaemonHello } from './daemon-client-hello-handshake'
import type { DaemonClientConnections } from './daemon-client-connections'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { DaemonTerminalAdmission } from './daemon-terminal-admission'
import type { TerminalHost } from './terminal-host'
import { PROTOCOL_VERSION } from './types'

describe('negotiated attachment and claimed execution', () => {
  it.each(['socket'] as const)(
    'preserves accepted startup and canonical adoption after %s replacement',
    async (_replacementKind) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-31182-admission-'))
      const socketPath = getDaemonSocketPath(directory)
      const tokenPath = join(directory, 'token')
      const subprocess = createMockSubprocess()
      let releaseSpawn = () => {}
      let started = () => {}
      const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      const spawnStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const spawn = vi.fn(async () => {
        started()
        await spawnGate
        return subprocess
      })
      const server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: spawn })
      const sockets: Socket[] = []
      try {
        await server.start()
        const token = readFileSync(tokenPath, 'utf8').trim()
        const clientId = randomUUID()
        const hello = async (role: 'control' | 'stream') => {
          const socket = createConnection(socketPath)
          sockets.push(socket)
          await once(socket, 'connect')
          return sendDaemonHello({
            socket,
            token,
            role,
            clientId,
            protocolVersion: PROTOCOL_VERSION,
            timeoutMs: 2000,
            requestBinaryStream: false
          })
        }
        await hello('control')
        await hello('stream')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the server's concrete production collaborators; only control dispatch is called directly.
        const daemon = server as unknown as {
          admission: DaemonTerminalAdmission
          connections: DaemonClientConnections
          host: TerminalHost
        }
        const claim = {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          agent: 'codex' as const
        }
        const surface = {
          worktreeId: 'worktree',
          tabId: 'tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: 'term_claimed'
        }
        const request = (sessionId: string) => ({
          id: randomUUID(),
          type: 'createOrAttach' as const,
          payload: {
            sessionId,
            cols: 80,
            rows: 24,
            command: 'typed-agent-command',
            agentSessionEnsure: { claim, surface },
            terminalState: true as const
          }
        })
        const accepted = daemon.admission.createOrAttach(clientId, request('canonical'))
        const canceled = expect(accepted).rejects.toThrow('Attach canceled for session canonical')
        await spawnStarted
        await hello('stream')
        releaseSpawn()
        await canceled
        expect(subprocess.write).toHaveBeenCalledExactlyOnceWith('typed-agent-command\r')
        expect(subprocess.forceKill).not.toHaveBeenCalled()
        await expect(
          daemon.admission.createOrAttach(clientId, request('different-requested-id'))
        ).resolves.toMatchObject({
          isNew: false,
          agentSessionEnsure: { disposition: 'adopted', owner: { ptyId: 'canonical' } },
          terminalState: true
        })
        expect(spawn).toHaveBeenCalledOnce()
        expect(subprocess.write).toHaveBeenCalledOnce()
        expect(daemon.host.listSessions()).toHaveLength(1)
      } finally {
        releaseSpawn()
        for (const socket of sockets) {
          socket.destroy()
        }
        subprocess._simulateExit(0)
        await server.shutdown()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
