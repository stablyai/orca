import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from '../daemon/client'
import { DaemonServer } from '../daemon/daemon-server'
import { runProcess } from '../../shared/child-process/run-process'
import { openWslDaemonConnectorStream } from './wsl-daemon-connector-stream'
import {
  WSL_DAEMON_CONNECTOR_SCRIPT,
  WSL_DAEMON_READ_TOKEN_SCRIPT
} from './wsl-daemon-connector-script'

it.skipIf(process.platform === 'win32')(
  'authenticates the actual daemon over two child pipes and reconnects to the same owner',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-guest-protocol-'))
    const plan = {
      socket: join(directory, 'd.sock'),
      tokenPath: join(directory, 'token'),
      userId: String(process.getuid?.()),
      home: process.env.HOME
    }
    const server = new DaemonServer({
      socketPath: plan.socket,
      tokenPath: plan.tokenPath,
      spawnSubprocess: () => {
        throw new Error('No terminal spawn expected')
      }
    })
    const observer = new DaemonClient({ socketPath: plan.socket, tokenPath: plan.tokenPath })
    const client = new DaemonClient({
      transport: {
        async readToken({ signal, timeoutMs }) {
          const result = await runProcess({
            program: process.execPath,
            args: ['-e', WSL_DAEMON_READ_TOKEN_SCRIPT, JSON.stringify(plan)],
            signal,
            timeoutMs
          })
          if (result.code !== 0) {
            throw new Error('Token read failed')
          }
          return result.stdout
        },
        connect: (_role, { signal }) =>
          openWslDaemonConnectorStream(
            {
              program: process.execPath,
              args: ['-e', WSL_DAEMON_CONNECTOR_SCRIPT, JSON.stringify(plan)]
            },
            signal
          )
      }
    })
    try {
      await server.start()
      await observer.ensureConnected()
      await client.ensureConnected()
      const identity = client.getDaemonIdentity()
      expect(identity?.pid).toBe(process.pid)
      expect(await client.request('ping', undefined)).toEqual({ pong: true })
      expect(await client.request('listSessions', undefined)).toEqual({ sessions: [] })
      client.disconnect()
      await client.ensureConnected()
      expect(client.getDaemonIdentity()).toEqual(identity)
      expect(await client.request('ping', undefined)).toEqual({ pong: true })
    } finally {
      client.disconnect()
      observer.disconnect()
      await server.shutdown()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
