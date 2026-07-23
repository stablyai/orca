import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { encodeNdjson } from './ndjson'
import type { SubprocessHandle } from './session'
import { PROTOCOL_VERSION } from './types'

function unusedSubprocess(): SubprocessHandle {
  throw new Error('Test must not create a PTY')
}

describe('daemon authenticated client activity', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-client-activity-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function connectHello(role: 'control' | 'stream', clientId: string): Promise<Socket> {
    const socket = connect(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      encodeNdjson({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId,
        role
      })
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('data', (data) => {
        const response = JSON.parse(data.toString().trim()) as { ok?: boolean; error?: string }
        if (response.ok) {
          resolve()
        } else {
          reject(new Error(response.error ?? 'hello rejected'))
        }
      })
      socket.once('error', reject)
    })
    return socket
  }

  it('excludes control-only health probes and reports one complete app pair', async () => {
    const onAuthenticatedClientPair = vi.fn()
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: unusedSubprocess,
      onAuthenticatedClientPair
    })
    await server.start()

    await connectHello('control', 'resolver-health-check')
    expect(onAuthenticatedClientPair).not.toHaveBeenCalled()

    await connectHello('control', 'app-client')
    expect(onAuthenticatedClientPair).not.toHaveBeenCalled()
    await connectHello('stream', 'app-client')
    expect(onAuthenticatedClientPair).toHaveBeenCalledOnce()
  })
})
