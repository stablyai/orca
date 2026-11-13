import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type * as ServePreflight from './serve-electron-preflight'

const { spawnMock, preflightMock, superviseMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  preflightMock: vi.fn(),
  superviseMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./serve-electron-preflight', async (original) => ({
  ...(await original<typeof ServePreflight>()),
  preflightElectronServe: preflightMock
}))
vi.mock('./serve-update-supervisor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  superviseForegroundServe: superviseMock
}))

import { serveOrcaApp } from './launch'

let actualPreflight: typeof ServePreflight
beforeAll(async () => {
  actualPreflight = await vi.importActual<typeof ServePreflight>('./serve-electron-preflight')
})

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

describe.skipIf(process.platform === 'win32')(
  'serve launch with actual preflight dependencies',
  () => {
    it.each(['absent', 'accepting'])(
      'reaches the existing launch/refusal seam for a %s endpoint',
      async (state) => {
        const root = mkdtempSync(join(tmpdir(), 'orca-serve-launch-'))
        const endpoint = join(root, 'runtime.sock')
        const sockets = new Set<Socket>()
        const server = createServer((socket) => {
          sockets.add(socket)
          socket.once('close', () => sockets.delete(socket))
          socket.resume()
        })
        try {
          vi.clearAllMocks()
          vi.stubEnv('ORCA_USER_DATA_PATH', root)
          vi.stubEnv('ORCA_APP_EXECUTABLE', '/opt/orca/orca')
          vi.stubEnv('ORCA_SERVE_RUNTIME', 'electron')
          writeFileSync(
            join(root, 'orca-runtime.json'),
            JSON.stringify({
              runtimeId: 'leftover',
              pid: 2147483647,
              authToken: 'fixture',
              transports: [{ kind: 'unix', endpoint }],
              startedAt: 1
            })
          )
          if (state === 'accepting') {
            await new Promise<void>((resolve) => server.listen(endpoint, resolve))
          }
          preflightMock.mockImplementation(actualPreflight.preflightElectronServe)
          superviseMock.mockResolvedValue(0)
          spawnMock.mockReturnValue(new FakeChildProcess())
          vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
          expect(await serveOrcaApp({})).toBe(state === 'absent' ? 0 : 3)
          expect(spawnMock).toHaveBeenCalledTimes(state === 'absent' ? 1 : 0)
        } finally {
          for (const socket of sockets) {
            socket.destroy()
          }
          if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()))
          }
          vi.restoreAllMocks()
          vi.unstubAllEnvs()
          rmSync(root, { recursive: true, force: true })
        }
      }
    )
  }
)
