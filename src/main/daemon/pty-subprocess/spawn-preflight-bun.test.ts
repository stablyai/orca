import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted((): { shellPid?: number } => ({}))
vi.mock('./bun-pty-process', () => ({
  canUseBunPty: () => true,
  spawnBunPty: () => ({
    pid: 41,
    get shellProcessId() {
      return fixture.shellPid
    },
    onExit(callback: (event: { exitCode: number }) => void) {
      queueMicrotask(() => callback({ exitCode: 0 }))
      return { dispose() {} }
    }
  })
}))

import { runPtySpawnHealthProbe } from './spawn-preflight'

beforeEach(() =>
  vi.stubGlobal(
    'process',
    Object.create(process, {
      platform: { value: 'win32' }
    })
  )
)
afterEach(() => vi.unstubAllGlobals())

it.each([undefined, 41, 0])(
  'refuses successful gate exit without shell identity %s',
  async (pid) => {
    fixture.shellPid = pid
    await expect(runPtySpawnHealthProbe()).rejects.toThrow('could not identify the Windows shell')
  }
)

it('accepts successful exit with the separate original shell identity', async () => {
  fixture.shellPid = 42
  await expect(runPtySpawnHealthProbe()).resolves.toBeUndefined()
})
