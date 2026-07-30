import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from './dispatcher'

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock
}))

import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'

function createContext(signal?: AbortSignal): RequestContext {
  return {
    clientId: 1,
    isStale: () => false,
    signal
  }
}

function createSpawnedDu() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('relay workspace space scan du handling', () => {
  let tempDir: string | null = null

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-relay-space-du-'))
    execFileMock.mockReset()
    spawnMock.mockReset()
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
      callback(new Error('execFile should not be used for workspace Space scans'))
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it.skipIf(process.platform === 'win32')(
    'streams native du output instead of using execFile buffering',
    async () => {
      await writeFile(join(tempDir!, 'app.ts'), 'console.log("ok")\n')
      const child = createSpawnedDu()
      spawnMock.mockReturnValue(child)

      const scanPromise = scanWorkspaceSpaceDirectory(tempDir!, createContext())

      await vi.waitFor(() =>
        expect(spawnMock).toHaveBeenCalledWith('du', ['-k', '-d', '1', tempDir], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
      )
      child.stdout.emit('data', Buffer.from(`4\t${join(tempDir!, 'app.ts')}\n`))
      child.stdout.emit('data', Buffer.from(`12\t${tempDir!}\n`))
      child.emit('close', 0)

      await expect(scanPromise).resolves.toMatchObject({
        sizeBytes: 12 * 1024,
        skippedEntryCount: 0,
        topLevelItems: [expect.objectContaining({ name: 'app.ts' })]
      })
      expect(execFileMock).not.toHaveBeenCalled()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves multibyte du paths split across stdout chunks',
    async () => {
      const dirname = '数据'
      await mkdir(join(tempDir!, dirname), { recursive: true })
      await writeFile(join(tempDir!, dirname, 'pkg.js'), Buffer.alloc(128))
      const child = createSpawnedDu()
      spawnMock.mockReturnValue(child)

      const scanPromise = scanWorkspaceSpaceDirectory(tempDir!, createContext())

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      const dirnameBytes = Buffer.from(dirname)
      const duLine = Buffer.from(`24\t${join(tempDir!, dirname)}\n`)
      const splitAt = duLine.indexOf(dirnameBytes) + 1
      child.stdout.emit('data', duLine.subarray(0, splitAt))
      child.stdout.emit('data', duLine.subarray(splitAt))
      child.stdout.emit('data', Buffer.from(`32\t${tempDir!}\n`))
      child.emit('close', 0)

      await expect(scanPromise).resolves.toMatchObject({
        sizeBytes: 32 * 1024,
        topLevelItems: [
          expect.objectContaining({
            name: dirname,
            sizeBytes: 24 * 1024
          })
        ]
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'bounds native du with a deadline while preserving cancellation',
    async () => {
      await writeFile(join(tempDir!, 'app.ts'), 'console.log("ok")\n')
      const controller = new AbortController()
      const child = createSpawnedDu()
      spawnMock.mockReturnValue(child)

      vi.useFakeTimers()
      const scanPromise = scanWorkspaceSpaceDirectory(tempDir!, createContext(controller.signal))

      await vi.waitFor(() =>
        expect(spawnMock).toHaveBeenCalledWith('du', ['-k', '-d', '1', tempDir], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
      )
      const rejection = expect(scanPromise).rejects.toMatchObject({
        name: 'RelayWorkspaceSpaceDuTimeoutError',
        message: 'du timed out after 120000ms'
      })
      await vi.advanceTimersByTimeAsync(120_000)

      controller.abort()
      await rejection
      expect(child.kill).toHaveBeenCalled()
    }
  )

  it('falls back accurately when native du is unavailable', async () => {
    await mkdir(join(tempDir!, 'node_modules'), { recursive: true })
    await writeFile(join(tempDir!, 'node_modules', 'pkg.js'), Buffer.alloc(512))
    await writeFile(join(tempDir!, 'app.ts'), Buffer.alloc(128))
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('du not found'), { code: 'ENOENT' })
    })

    await expect(scanWorkspaceSpaceDirectory(tempDir!, createContext())).resolves.toMatchObject({
      skippedEntryCount: 0,
      topLevelItems: expect.arrayContaining([
        expect.objectContaining({ name: 'node_modules', sizeBytes: expect.any(Number) }),
        expect.objectContaining({ name: 'app.ts', sizeBytes: 128 })
      ])
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
