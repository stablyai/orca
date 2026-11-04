import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { DaemonClient } from './client'
import { checkDaemonHealthWithCoverage } from './daemon-health'
import { createOutOfProcessLauncher } from './daemon-out-of-process-launcher'

import { getDaemonSocketBindPath } from './daemon-endpoint-ownership'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { ensureDaemonSocketDir, shortDaemonSocketDir } from './daemon-socket-endpoint-path'

describe.skipIf(process.platform === 'win32')('relocated endpoint binds (#17840)', () => {
  const uid = process.getuid!()
  let base = ''
  let runtimeDir = ''

  afterEach(() => {
    rmSync(shortDaemonSocketDir(runtimeDir, uid), { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
    try {
      rmdirSync(dirname(shortDaemonSocketDir(runtimeDir, uid)))
    } catch {
      // Another Orca instance may still use the shared parent.
    }
  })

  it('creates a private dir the over-long data root can bind its socket in', async () => {
    base = mkdtempSync(join(tmpdir(), 'orca-long-'))
    runtimeDir = join(base, 'x'.repeat(130))
    mkdirSync(runtimeDir, { recursive: true })
    const socketPath = getDaemonSocketPath(runtimeDir, 99)
    expect(socketPath.startsWith(runtimeDir)).toBe(false)

    ensureDaemonSocketDir(socketPath)
    expect(lstatSync(shortDaemonSocketDir(runtimeDir, uid)).mode & 0o777).toBe(0o700)
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(getDaemonSocketBindPath(socketPath), resolve)
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  it('never connects to a listener planted in a shared relocated dir', async () => {
    base = mkdtempSync(join(tmpdir(), 'orca-long-'))
    runtimeDir = join(base, 'x'.repeat(130))
    mkdirSync(runtimeDir, { recursive: true })
    const socketPath = getDaemonSocketPath(runtimeDir, 99)
    const tokenPath = getDaemonTokenPath(runtimeDir, 99)
    writeFileSync(tokenPath, 'secret-token')
    // Shared permissions model an untrusted directory despite the test owning it.
    mkdirSync(shortDaemonSocketDir(runtimeDir, uid), { recursive: true, mode: 0o700 })
    chmodSync(shortDaemonSocketDir(runtimeDir, uid), 0o777)
    const received: string[] = []
    const accepted: Socket[] = []
    const fake: Server = createServer((socket) => {
      accepted.push(socket)
      socket.on('data', (chunk) => {
        received.push(chunk.toString())
        socket.write(`${JSON.stringify({ type: 'hello', ok: true })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      fake.once('error', reject)
      fake.listen(socketPath, resolve)
    })
    setAppEnvironment({
      getPath: () => base,
      getAppPath: () => base,
      getVersion: () => '0.0.0',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    try {
      await expect(createOutOfProcessLauncher(runtimeDir)(socketPath, tokenPath)).rejects.toThrow(
        /not a private directory/
      )
      await expect(new DaemonClient({ socketPath, tokenPath }).ensureConnected()).rejects.toThrow(
        /not a private directory/
      )
      await expect(checkDaemonHealthWithCoverage(socketPath, tokenPath)).resolves.toMatchObject({
        verdict: 'unreachable'
      })
      expect(accepted).toHaveLength(0)
      expect(received).toEqual([])
    } finally {
      for (const socket of accepted) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })
})
