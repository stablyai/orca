import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacOSProviderProcessOwner } from './macos-native-provider-process-reaping'
import { startMacOSNativeProviderSocket } from './macos-native-provider-transport'

const { connectMock, spawnMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
vi.mock('./macos-native-provider-socket', () => ({
  connectMacOSProviderSocket: connectMock
}))

class Provider extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn()
  unref(): void {}
}

describe('superseded macOS provider startup cleanup', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const result of spawnMock.mock.results) {
      if (result.value instanceof Provider) {
        result.value.emit('exit', 0, null)
      }
    }
    vi.useRealTimers()
    vi.resetAllMocks()
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['socket rejection', 'provider exit'])(
    'removes only its own directory on %s',
    async (failure) => {
      vi.useFakeTimers()
      const provider = new Provider()
      spawnMock.mockReturnValue(provider)
      let rejectConnection = (_error: Error): void => {}
      connectMock.mockImplementation(
        (socketPath: string, _timeout: number, signal: AbortSignal) => {
          directories.push(dirname(socketPath))
          return new Promise((_resolve, reject) => {
            rejectConnection = reject
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          })
        }
      )
      let current = true
      const owner = new MacOSProviderProcessOwner()
      const startup = startMacOSNativeProviderSocket({
        helperExecutablePath: 'fixture-provider',
        isCurrent: () => current,
        providerProcess: owner
      })
      const rejection = expect(startup).rejects.toThrow()
      const ownDirectory = directories[0]!
      expect(existsSync(join(ownDirectory, 'provider.token'))).toBe(true)
      const replacementDirectory = mkdtempSync(join(tmpdir(), 'orca-computer-use-replacement-'))
      directories.push(replacementDirectory)
      const replacementToken = join(replacementDirectory, 'provider.token')
      writeFileSync(replacementToken, 'replacement-token')

      current = false
      owner.reap()
      if (failure === 'provider exit') {
        provider.exitCode = 0
        provider.emit('exit', 0, null)
      } else {
        rejectConnection(new Error('socket did not open'))
      }

      await rejection
      expect(existsSync(ownDirectory)).toBe(false)
      expect(existsSync(replacementToken)).toBe(true)
    }
  )

  it('removes its temporary directory when the helper cannot be spawned', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('invalid spawn options')
    })
    const owner = new MacOSProviderProcessOwner()
    const startup = startMacOSNativeProviderSocket({
      helperExecutablePath: 'missing-provider',
      isCurrent: () => true,
      providerProcess: owner
    })
    const socketPath = spawnMock.mock.calls[0]?.[1]?.[1]
    if (typeof socketPath !== 'string') {
      throw new Error('missing provider socket path')
    }
    const socketDirectory = dirname(socketPath)
    directories.push(socketDirectory)

    await expect(startup).rejects.toThrow('invalid spawn options')
    expect(existsSync(socketDirectory)).toBe(false)
  })

  it('releases each temporary directory when writing its token fails', async () => {
    vi.mocked(writeFileSync).mockImplementation((path) => {
      if (typeof path !== 'string') {
        throw new Error('missing token path')
      }
      directories.push(dirname(path))
      throw new Error('ENOSPC')
    })
    const owner = new MacOSProviderProcessOwner()
    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(
        startMacOSNativeProviderSocket({
          helperExecutablePath: 'fixture-provider',
          isCurrent: () => true,
          providerProcess: owner
        })
      ).rejects.toThrow('ENOSPC')
      expect(directories).toHaveLength(attempt + 1)
      for (const directory of directories) {
        expect(existsSync(directory)).toBe(false)
      }
    }
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
