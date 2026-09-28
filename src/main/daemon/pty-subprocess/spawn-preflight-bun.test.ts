import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(
  (): {
    shellPid?: number
    available: boolean
    immediateExit: boolean
    dispose: ReturnType<typeof vi.fn>
    dataDispose: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    waitForDa1: boolean
    writeFails: boolean
    hang: boolean
    kill: ReturnType<typeof vi.fn>
  } => ({
    shellPid: Number.NaN,
    available: true,
    immediateExit: false,
    dispose: vi.fn(),
    dataDispose: vi.fn(),
    write: vi.fn(),
    waitForDa1: false,
    writeFails: false,
    hang: false,
    kill: vi.fn()
  })
)
vi.mock('./bun-pty-process', () => ({
  canUseBunPty: () => fixture.available,
  spawnBunPty: () => ({
    pid: 41,
    get shellProcessId() {
      return fixture.shellPid
    },
    write: fixture.write,
    kill: fixture.kill,
    onData(callback: (data: string) => void) {
      if (fixture.waitForDa1) {
        callback('\x1b[')
        callback('0c')
      }
      return { dispose: fixture.dataDispose }
    },
    onExit(callback: (event: { exitCode: number }) => void) {
      if (fixture.hang) {
        return { dispose: fixture.dispose }
      }
      if (fixture.waitForDa1) {
        fixture.write.mockImplementation(() => {
          if (fixture.writeFails) {
            throw new Error('probe write failed')
          }
          callback({ exitCode: 0 })
        })
      } else if (fixture.immediateExit) {
        callback({ exitCode: 0 })
      } else {
        queueMicrotask(() => callback({ exitCode: 0 }))
      }
      return { dispose: fixture.dispose }
    }
  })
}))

import { preflightPtySpawnHealth, runPtySpawnHealthProbe } from './spawn-preflight'

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
  fixture.dispose.mockClear()
  await expect(runPtySpawnHealthProbe()).resolves.toBeUndefined()
  expect(fixture.dispose).toHaveBeenCalledOnce()
})

it('rejects health preflight outside the bundled runtime', async () => {
  fixture.available = false
  try {
    expect(() => preflightPtySpawnHealth()).toThrow('requires the bundled Bun')
    await expect(runPtySpawnHealthProbe()).rejects.toThrow('requires the bundled Bun')
  } finally {
    fixture.available = true
  }
})

it('disposes the subscription when a probe has already exited before registration', async () => {
  fixture.shellPid = 42
  fixture.immediateExit = true
  fixture.dispose.mockClear()
  try {
    await expect(runPtySpawnHealthProbe()).resolves.toBeUndefined()
    expect(fixture.dispose).toHaveBeenCalledOnce()
  } finally {
    fixture.immediateExit = false
  }
})

it('answers split DA1 queries and releases probe resources', async () => {
  fixture.shellPid = 42
  fixture.waitForDa1 = true
  fixture.write.mockReset()
  fixture.dataDispose.mockClear()
  try {
    await expect(runPtySpawnHealthProbe()).resolves.toBeUndefined()
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith('\x1b[?1;2c')
    expect(fixture.dataDispose).toHaveBeenCalledOnce()
  } finally {
    fixture.waitForDa1 = false
    fixture.write.mockReset()
  }
})

it('kills the probe and releases subscriptions if the DA1 reply fails', async () => {
  fixture.shellPid = 42
  fixture.waitForDa1 = true
  fixture.writeFails = true
  fixture.kill.mockClear()
  fixture.dispose.mockClear()
  fixture.dataDispose.mockClear()
  try {
    await expect(runPtySpawnHealthProbe()).rejects.toThrow('probe write failed')
    expect(fixture.kill).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.dataDispose).toHaveBeenCalledOnce()
  } finally {
    fixture.waitForDa1 = false
    fixture.writeFails = false
    fixture.write.mockReset()
  }
})

it('kills a timed-out probe and releases both subscriptions', async () => {
  vi.useFakeTimers()
  fixture.hang = true
  fixture.kill.mockClear()
  fixture.dispose.mockClear()
  fixture.dataDispose.mockClear()
  try {
    const rejected = expect(runPtySpawnHealthProbe()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(4_000)
    await rejected
    expect(fixture.kill).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.dataDispose).toHaveBeenCalledOnce()
  } finally {
    fixture.hang = false
    vi.useRealTimers()
  }
})
