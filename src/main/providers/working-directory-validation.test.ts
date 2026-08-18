import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslUncDirectoryExistsAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, wslUncDirectoryExistsAsync: wslUncDirectoryExistsAsyncMock }
})

import { validateWorkingDirectoryAsync } from './local-pty-utils'
import { _resetWorkingDirectoryValidationStateForTest } from './working-directory-validation'

let tempDir: string

/** UNC probes now start after a lane acquire, so let that microtask land. */
const flushLaneAcquire = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(async () => {
  wslUncDirectoryExistsAsyncMock.mockReset()
  wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
  _resetWorkingDirectoryValidationStateForTest()
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'orca-cwd-validate-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('validateWorkingDirectoryAsync', () => {
  it('accepts an existing directory', async () => {
    await expect(validateWorkingDirectoryAsync(tempDir)).resolves.toBeUndefined()
  })

  it('rejects a missing directory with the actionable unmounted-volume message', async () => {
    await expect(validateWorkingDirectoryAsync(path.join(tempDir, 'gone'))).rejects.toThrow(
      /does not exist.*unmounted volume/s
    )
  })

  it('rejects a path that exists but is a file', async () => {
    const filePath = path.join(tempDir, 'not-a-dir.txt')
    await writeFile(filePath, 'x')

    await expect(validateWorkingDirectoryAsync(filePath)).rejects.toThrow('is not a directory')
  })

  it('never blocks the event loop while the filesystem answers', async () => {
    // A dead UNC share must not freeze unrelated daemon RPCs (STA-4470).
    let ticked = false
    const pending = validateWorkingDirectoryAsync(tempDir)
    setImmediate(() => {
      ticked = true
    })

    await pending

    expect(ticked).toBe(true)
  })

  describe('cancellation', () => {
    // Unique per test: the dedupe map is module-level, and a never-settling
    // probe would otherwise leak into later cases.
    const deadShare = (name: string): string => `\\\\wsl.localhost\\Ubuntu\\dead-${name}`

    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('lets an aborted caller give up on a probe that never answers', async () => {
      // fs.stat takes no signal, so the caller leaves; the probe keeps running.
      wslUncDirectoryExistsAsyncMock.mockReturnValue(new Promise<boolean>(() => {}))
      const abort = new AbortController()

      const pending = validateWorkingDirectoryAsync(deadShare('abort'), { signal: abort.signal })
      abort.abort()

      await expect(pending).rejects.toThrow('was canceled')
    })

    it('rejects immediately when the signal is already aborted', async () => {
      wslUncDirectoryExistsAsyncMock.mockReturnValue(new Promise<boolean>(() => {}))

      await expect(
        validateWorkingDirectoryAsync(deadShare('pre-aborted'), { signal: AbortSignal.abort() })
      ).rejects.toThrow('was canceled')
    })

    it('leaves the shared probe intact for callers that are still waiting', async () => {
      let releaseProbe: () => void = () => {}
      wslUncDirectoryExistsAsyncMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          releaseProbe = () => resolve(true)
        })
      )
      const abort = new AbortController()

      const shared = deadShare('shared')
      const staying = validateWorkingDirectoryAsync(shared)
      const leaving = validateWorkingDirectoryAsync(shared, { signal: abort.signal })
      abort.abort()
      await expect(leaving).rejects.toThrow('was canceled')

      releaseProbe()
      await expect(staying).resolves.toBeUndefined()
      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledOnce()
    })

    it('never pins a second probe on a path whose probe is still hung', async () => {
      vi.useFakeTimers()
      try {
        wslUncDirectoryExistsAsyncMock.mockReturnValue(new Promise<boolean>(() => {}))
        const hung = deadShare('still-hung')

        // `fs.stat` is uninterruptible, so retiring the entry on a timer would
        // free no libuv thread — it would only let each retry pin another, and
        // the default pool of 4 is exhausted after a few rounds.
        for (let retry = 0; retry < 4; retry += 1) {
          void validateWorkingDirectoryAsync(hung).catch(() => {})
          await vi.advanceTimersByTimeAsync(60_000)
        }

        expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })

    it('re-probes once the previous probe settles, so a recovered mount is seen', async () => {
      wslUncDirectoryExistsAsyncMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const recovering = deadShare('recovers')

      await expect(validateWorkingDirectoryAsync(recovering)).rejects.toThrow(/does not exist/)
      await expect(validateWorkingDirectoryAsync(recovering)).resolves.toBeUndefined()
      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('UNC route concurrency', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('caps concurrent probes against one unreachable distro', async () => {
      // Four dead paths would otherwise hold all four libuv fs threads.
      let inFlight = 0
      let peak = 0
      wslUncDirectoryExistsAsyncMock.mockImplementation(
        () =>
          new Promise<boolean>(() => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
          })
      )

      for (let index = 0; index < 4; index += 1) {
        void validateWorkingDirectoryAsync(`\\\\wsl.localhost\\Ubuntu\\capped-${index}`).catch(
          () => {}
        )
      }
      await flushLaneAcquire()

      expect(peak).toBe(2)
    })

    it('keeps a healthy local path out of a stalled share queue', async () => {
      wslUncDirectoryExistsAsyncMock.mockReturnValue(new Promise<boolean>(() => {}))
      for (let index = 0; index < 4; index += 1) {
        void validateWorkingDirectoryAsync(`\\\\wsl.localhost\\Ubuntu\\blocking-${index}`).catch(
          () => {}
        )
      }

      // A local-disk path must not queue behind a dead server.
      await expect(validateWorkingDirectoryAsync(tempDir)).resolves.toBeUndefined()
    })

    it('gives separate servers separate lanes', async () => {
      let inFlight = 0
      wslUncDirectoryExistsAsyncMock.mockImplementation(
        () =>
          new Promise<boolean>(() => {
            inFlight += 1
          })
      )

      for (const distro of ['AlphaDistro', 'BetaDistro']) {
        for (let index = 0; index < 2; index += 1) {
          void validateWorkingDirectoryAsync(`\\\\wsl.localhost\\${distro}\\lane-${index}`).catch(
            () => {}
          )
        }
      }
      await flushLaneAcquire()

      expect(inFlight).toBe(4)
    })
  })

  describe('WSL UNC paths', () => {
    const wslPath = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'

    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('asks the distro asynchronously and accepts its yes', async () => {
      wslUncDirectoryExistsAsyncMock.mockResolvedValue(true)

      await expect(validateWorkingDirectoryAsync(wslPath)).resolves.toBeUndefined()
      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledWith(wslPath)
    })

    it('shares one in-flight probe for the same working directory', async () => {
      let releaseProbe: () => void = () => {}
      wslUncDirectoryExistsAsyncMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          releaseProbe = () => resolve(true)
        })
      )

      const first = validateWorkingDirectoryAsync(wslPath)
      const second = validateWorkingDirectoryAsync(wslPath)
      await flushLaneAcquire()
      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledOnce()

      releaseProbe()
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    })

    it('keeps byte-distinct working directories in separate probes', async () => {
      wslUncDirectoryExistsAsyncMock.mockResolvedValue(true)
      const decomposedPath = `${wslPath}-e\u0301`
      const composedPath = `${wslPath}-\u00e9`

      await Promise.all([
        validateWorkingDirectoryAsync(decomposedPath),
        validateWorkingDirectoryAsync(composedPath)
      ])

      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledTimes(2)
    })

    it(`rejects on the distro no without falling back to a Win32 stat`, async () => {
      wslUncDirectoryExistsAsyncMock.mockResolvedValue(false)

      await expect(validateWorkingDirectoryAsync(wslPath)).rejects.toThrow(/does not exist/)
    })

    it('falls back to the filesystem when the distro probe is inconclusive', async () => {
      // An inconclusive guest probe is not proof that the directory is missing.
      wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)

      await expect(validateWorkingDirectoryAsync(wslPath)).rejects.toThrow(/does not exist/)
      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledOnce()
    })
  })
})
