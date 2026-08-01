import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

describe('DaemonServer token authentication', () => {
  it('rejects a non-string token that stringifies to the secret', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-daemon-token-auth-'))
    const tokenPath = join(directory, 'daemon.token')
    const server = new DaemonServer({
      socketPath: getDaemonSocketPath(directory),
      tokenPath,
      spawnSubprocess: () => {
        throw new Error('Unexpected subprocess spawn')
      }
    })
    await server.start()
    const socket = connect(getDaemonSocketPath(directory))
    try {
      await new Promise<void>((resolve) => socket.on('connect', resolve))
      const token = readFileSync(tokenPath, 'utf8').trim()
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          version: PROTOCOL_VERSION,
          token: [token],
          clientId: 'bad-client',
          role: 'control'
        })}\n`
      )
      const response = await new Promise<string>((resolve) => {
        socket.on('data', (data) => resolve(data.toString()))
      })
      expect(JSON.parse(response.trim()).ok).toBe(false)
    } finally {
      socket.destroy()
      await server.shutdown()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
