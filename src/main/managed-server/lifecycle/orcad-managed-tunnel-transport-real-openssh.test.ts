/**
 * Real OpenSSH: the managed tunnel reaches orcad wherever the connection's exec works, through a
 * user ControlMaster whose login a standalone forward cannot repeat, and on a persisted port an
 * older Orca's muxed forward still holds. Opt-in (needs sshd and ssh on PATH):
 * ORCA_REAL_OPENSSH_TEST=1 pnpm test src/main/managed-server/lifecycle/orcad-managed-tunnel-transport-real-openssh.test.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshExecOptions } from '../../ssh/connection/ssh-exec-options'
import { knownOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import type { PortForwardStartOptions } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { spawnSystemSshCommand } from '../../ssh/system-transport/system-ssh-command'
import {
  REAL_OPENSSH_TEST_ENABLED,
  dial,
  freePort,
  startRealOpenSshFixture,
  type RealOpenSshFixture
} from '../../ssh/system-transport/real-openssh-sshd-fixture'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'

const GREETING = 'orcad-fixture'

/** First line orcad's stand-in sends, read through the tunnel's local listener. */
function readGreeting(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('no greeting through the tunnel'))
    }, 15_000)
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (received.includes('\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(received.split('\n')[0] ?? '')
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe.skipIf(!REAL_OPENSSH_TEST_ENABLED)(
  'the managed tunnel through a user ControlMaster (real OpenSSH)',
  () => {
    let fixture: RealOpenSshFixture
    let orcad: Server
    const orcadSockets = new Set<Socket>()
    let orcadPort = 0
    // The user's own LocalForward in their ssh_config, which the master opened and must keep.
    let configuredForwardPort = 0
    let conn: SshConnection

    const options = (localPort: number): PortForwardStartOptions => ({
      id: 'pf-real',
      connectionId: 'real-openssh-tunnel',
      localHost: '127.0.0.1',
      localPort,
      remoteHost: '127.0.0.1',
      remotePort: orcadPort
    })
    const mux = (request: 'forward' | 'cancel', localPort: number, remotePort: number) =>
      fixture.ssh(['-O', request, '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`])

    beforeEach(async () => {
      orcad = createServer((socket) => {
        orcadSockets.add(socket)
        socket.on('close', () => orcadSockets.delete(socket))
        socket.on('error', () => {})
        socket.write(`${GREETING}\n`)
      })
      await new Promise<void>((resolve) => orcad.listen(0, '127.0.0.1', resolve))
      const address = orcad.address()
      orcadPort = typeof address === 'object' && address ? address.port : 0
      configuredForwardPort = await freePort()
      fixture = await startRealOpenSshFixture({
        client: [`LocalForward 127.0.0.1:${configuredForwardPort} 127.0.0.1:${orcadPort}`]
      })
      // The host's pinned Node, where the stdio bridge looks for it under the session's HOME.
      const nodeBin = join(fixture.remoteHome, '.orca-remote', 'runtimes', 'node-fixture', 'bin')
      mkdirSync(nodeBin, { recursive: true })
      symlinkSync(
        execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(),
        join(nodeBin, 'node')
      )
      const stub = {
        getTarget: () => fixture.target,
        getSystemSshBuildArgsOptions: fixture.buildOptions,
        usesSystemSshTransport: () => true,
        getClient: () => null,
        getConnectGeneration: () => 1,
        // The connection's own exec: through the user's master, as every remote command goes.
        exec: async (command: string, execOptions?: SshExecOptions) =>
          spawnSystemSshCommand(fixture.target, command, {
            ...fixture.buildOptions(),
            ...execOptions
          })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport, the system SSH forward and the stdio bridge read only these members.
      conn = stub as unknown as SshConnection
    }, 30_000)

    afterEach(async () => {
      // Why: sshd may hold its end of a forwarded socket past the forward's own exit.
      for (const socket of orcadSockets) {
        socket.destroy()
      }
      await new Promise((resolve) => orcad.close(resolve))
      await fixture.close()
    })

    it('forwards when a fresh login works', async () => {
      const tunnel = await new OrcadManagedTunnelTransportProvider().start(conn, options(0))
      try {
        expect(knownOrcadTunnelTransport('real-openssh-tunnel')).toBe('tcp_forward')
        expect(await readGreeting(tunnel.entry.localPort)).toBe(GREETING)
      } finally {
        await tunnel.close()
      }
    }, 30_000)

    // Why: an MFA or hardware-key login lives on in the master, but a standalone forward must log in again.
    it('reaches orcad through the bridge when only the master can log in', async () => {
      fixture.refuseNewLogins()
      const tunnel = await new OrcadManagedTunnelTransportProvider().start(conn, options(0))
      try {
        expect(knownOrcadTunnelTransport('real-openssh-tunnel')).toBe('stdio_bridge')
        expect(await readGreeting(tunnel.entry.localPort)).toBe(GREETING)
      } finally {
        await tunnel.close()
      }
    }, 30_000)

    it('takes back a persisted port an older Orca’s forward left on the master', async () => {
      const persisted = await freePort()
      mux('forward', persisted, orcadPort)
      expect(await dial(persisted)).toBe(true)

      const tunnel = await new OrcadManagedTunnelTransportProvider().start(conn, options(persisted))
      try {
        expect(tunnel.entry.localPort).toBe(persisted)
        expect(knownOrcadTunnelTransport('real-openssh-tunnel')).toBe('tcp_forward')
        expect(await readGreeting(persisted)).toBe(GREETING)
      } finally {
        await tunnel.close()
      }
      // The master and the user's own forward on it stay up; only Orca's stale forward went.
      expect(() => fixture.ssh(['-O', 'check'])).not.toThrow()
      expect(await readGreeting(configuredForwardPort)).toBe(GREETING)
      expect(await dial(persisted)).toBe(false)
    }, 30_000)

    it('takes back that port and bridges when only the master can log in', async () => {
      const persisted = await freePort()
      mux('forward', persisted, orcadPort)
      fixture.refuseNewLogins()

      const tunnel = await new OrcadManagedTunnelTransportProvider().start(conn, options(persisted))
      try {
        expect(tunnel.entry.localPort).toBe(persisted)
        expect(knownOrcadTunnelTransport('real-openssh-tunnel')).toBe('stdio_bridge')
        expect(await readGreeting(persisted)).toBe(GREETING)
      } finally {
        await tunnel.close()
      }
      expect(await readGreeting(configuredForwardPort)).toBe(GREETING)
    }, 30_000)

    it('leaves a master’s forward to anywhere else alone', async () => {
      const persisted = await freePort()
      const elsewhere = await freePort()
      mux('forward', persisted, elsewhere)

      await expect(
        new OrcadManagedTunnelTransportProvider().start(conn, options(persisted))
      ).rejects.toThrow(/is not available/)
      expect(await dial(persisted)).toBe(true)
      mux('cancel', persisted, elsewhere)
    }, 30_000)
  }
)
