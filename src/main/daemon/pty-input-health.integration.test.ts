import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { checkPtySpawnHealth } from './pty-subprocess'
import { createPtySubprocess } from './pty-subprocess'
import { probeLegacyDaemonInput } from './legacy-daemon-input-probe'

const itOnPosix = process.platform === 'win32' ? it.skip : it

describe('native PTY input health', () => {
  itOnPosix('proves a real spawned shell receives input before reporting healthy', async () => {
    await expect(checkPtySpawnHealth()).resolves.toBeUndefined()
  })

  itOnPosix('delivers an acknowledged command through a real daemon and PTY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-input-health-e2e-'))
    const socketPath = join(dir, 'daemon.sock')
    const tokenPath = join(dir, 'daemon.token')
    const server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: createPtySubprocess })
    await server.start()
    const adapter = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      respawn: async () => {
        throw new Error('healthy input probe must not respawn')
      }
    })
    let output = ''
    adapter.onData((payload) => {
      output += payload.data
    })

    try {
      const { id } = await adapter.spawn({
        sessionId: 'real-input-probe',
        cols: 80,
        rows: 24,
        cwd: dir
      })
      await expect(adapter.writeAccepted(id, 'printf "__ORCA_INPUT_E2E_OK__\\n"\n')).resolves.toBe(
        true
      )
      await expect
        .poll(() => output.includes('__ORCA_INPUT_E2E_OK__'), { timeout: 3_000 })
        .toBe(true)
      await adapter.shutdown(id, { immediate: true })
    } finally {
      adapter.dispose()
      await server.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itOnPosix('proves input through a real protocol-v30 daemon and PTY before adoption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-input-health-e2e-'))
    const socketPath = join(dir, 'daemon-v30.sock')
    const tokenPath = join(dir, 'daemon-v30.token')
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion: 30,
      spawnSubprocess: createPtySubprocess
    })
    await server.start()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })

    try {
      await expect(probeLegacyDaemonInput(adapter, dir)).resolves.toBe(true)
    } finally {
      adapter.dispose()
      await server.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
