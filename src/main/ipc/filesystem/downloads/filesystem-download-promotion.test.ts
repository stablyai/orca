import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return { ...fs, link: vi.fn(fs.link), lstat: vi.fn(fs.lstat), open: vi.fn(fs.open) }
})

import { link, lstat, open } from 'node:fs/promises'
import { promoteDownloadedFileWithoutOverwrite } from './filesystem-download-promotion'

const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
const dirs: string[] = []

afterEach(async () => {
  vi.mocked(link).mockImplementation(fs.link)
  vi.mocked(lstat).mockImplementation(fs.lstat)
  vi.mocked(open).mockImplementation(fs.open)
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const ioError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code })
const WRITE_ERROR = 'ENOSPC: no space left on device, write'
const CLOSE_ERROR = 'EIO: i/o error, close'
const SOURCE_CLOSE_ERROR = 'EIO: i/o error, close (staged copy)'

type Trouble = {
  // The new file's write fails after half of it landed.
  write?: boolean
  // The new file's close reports a lost write.
  close?: boolean
  // Closing the read-only staged copy fails.
  sourceClose?: boolean
  // A Cancel arrives while the new file is being written.
  cancel?: boolean
}
type Hook = (destinationPath: string) => Promise<unknown>

/**
 * Moves a finished download into Downloads on a volume without hard links, so it is copied into a
 * newly created file, with the given trouble. `atTrouble` runs when the first trouble happens;
 * `onInspect` runs whenever the destination's name is looked up after it.
 */
async function copyWithTrouble(
  trouble: Trouble,
  hooks: { atTrouble?: Hook; onInspect?: Hook } = {}
) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'download-promotion-'))
  dirs.push(dir)
  const tempPath = path.join(dir, '.part')
  const destinationPath = path.join(dir, 'report.pdf')
  await fs.writeFile(tempPath, 'copied')
  const controller = new AbortController()
  const seen = { troubled: false, targetClosed: false }
  const troubleNow = async (): Promise<void> => {
    if (!seen.troubled) {
      seen.troubled = true
      await hooks.atTrouble?.(destinationPath)
    }
  }

  vi.mocked(link).mockRejectedValue(ioError('no links', 'EPERM'))
  vi.mocked(lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await fs.lstat(...args)
    if (seen.troubled && args[0] === destinationPath) {
      await hooks.onInspect?.(destinationPath)
    }
    return result
  })
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    const close = handle.close.bind(handle)
    if (args[1] !== 'wx') {
      return Object.assign(handle, {
        close: async () => {
          await close()
          if (trouble.sourceClose) {
            await troubleNow()
            throw ioError(SOURCE_CLOSE_ERROR, 'EIO')
          }
        }
      })
    }
    // Bound before the wrapper below replaces it on the handle.
    const realWrite = handle.write.bind(handle)
    const write = (bytes: Buffer) => realWrite(bytes, 0, bytes.byteLength)
    return Object.assign(handle, {
      // The staged copy is 'copied': the first half lands, then the trouble, then the rest.
      write: async (buffer: Uint8Array, _offset?: number, length = buffer.byteLength) => {
        await write(Buffer.from('cop'))
        if (trouble.write) {
          await troubleNow()
          throw ioError(WRITE_ERROR, 'ENOSPC')
        }
        if (trouble.cancel) {
          controller.abort(new Error('Canceled.'))
          await troubleNow()
        }
        await write(Buffer.from('ied'))
        return { bytesWritten: length, buffer }
      },
      close: async () => {
        await close()
        seen.targetClosed = true
        if (trouble.close) {
          await troubleNow()
          throw ioError(CLOSE_ERROR, 'EIO')
        }
      }
    })
  })

  const outcome = await promoteDownloadedFileWithoutOverwrite(
    tempPath,
    destinationPath,
    async () => path.join(dir, 'report (1).pdf'),
    controller.signal
  ).then(
    (savedAt) => ({ savedAt, error: null }),
    (error: unknown) => ({
      savedAt: null,
      error: error instanceof Error ? error : new Error(String(error))
    })
  )
  return { dir, destinationPath, outcome, targetClosed: seen.targetClosed }
}

const stoppedPartway = (destinationPath: string, reason: string): string =>
  `Saving to ${destinationPath} stopped partway (${reason}). An incomplete file may be left there.`

/** Another app saves its own file under the same name (moved in, so it is a different file). */
async function anotherAppSaves(destinationPath: string): Promise<void> {
  const theirs = path.join(path.dirname(destinationPath), 'their-save')
  await fs.writeFile(theirs, 'theirs')
  await fs.rename(theirs, destinationPath)
}

describe('moving a download into Downloads on a volume without hard links', () => {
  it.each<[string, Trouble, string]>([
    ['write fails', { write: true }, WRITE_ERROR],
    ['close reports a lost write', { close: true }, CLOSE_ERROR]
  ])('reports a failed copy (%s) and leaves what it wrote', async (_name, trouble, reason) => {
    const { dir, destinationPath, outcome, targetClosed } = await copyWithTrouble(trouble)

    // Nothing at the name is removed; the staging copy is left for the caller to clean up.
    expect((await fs.readdir(dir)).sort()).toEqual(['.part', 'report.pdf'])
    expect(targetClosed).toBe(true)
    expect(outcome.savedAt).toBeNull()
    expect(outcome.error?.message).toBe(stoppedPartway(destinationPath, reason))
  })

  it.each<[string, Trouble, 'atTrouble' | 'onInspect']>([
    ['write fails, saved as it fails', { write: true }, 'atTrouble'],
    ['close fails, saved as it fails', { close: true }, 'atTrouble'],
    ['write fails, saved when Orca looks at the name', { write: true }, 'onInspect'],
    ['close fails, saved when Orca looks at the name', { close: true }, 'onInspect']
  ])(
    'never removes a file another app saved under the name (%s)',
    async (_name, trouble, moment) => {
      let saved = false
      const save = async (destinationPath: string): Promise<void> => {
        if (!saved) {
          saved = true
          await anotherAppSaves(destinationPath)
        }
      }
      const { dir, destinationPath, outcome } = await copyWithTrouble(trouble, { [moment]: save })
      // Orca never looked at the name: the app saves now, after Orca stopped.
      await save(destinationPath)

      // Custody first, whatever the error says.
      expect(await fs.readFile(destinationPath, 'utf8')).toBe('theirs')
      expect((await fs.readdir(dir)).sort()).toEqual(['.part', 'report.pdf'])
      expect(outcome.savedAt).toBeNull()
      expect(outcome.error?.message).toBe(
        stoppedPartway(destinationPath, trouble.write ? WRITE_ERROR : CLOSE_ERROR)
      )
    }
  )

  it('says only that an incomplete file may be left when the name was removed meanwhile', async () => {
    const { dir, destinationPath, outcome } = await copyWithTrouble(
      { close: true },
      { atTrouble: (destinationPath) => fs.rm(destinationPath) }
    )

    expect(await fs.readdir(dir)).toEqual(['.part'])
    expect(outcome.error?.message).toBe(stoppedPartway(destinationPath, CLOSE_ERROR))
  })

  it('finishes a copy that a cancel reaches after it started, rather than leave part of it', async () => {
    const { dir, destinationPath, outcome } = await copyWithTrouble({ cancel: true })

    expect(outcome).toEqual({ savedAt: destinationPath, error: null })
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('copied')
    expect(await fs.readdir(dir)).toEqual(['report.pdf'])
  })

  describe('which failure is reported', () => {
    it('saves when only closing the read-only staged copy fails', async () => {
      const { destinationPath, outcome, targetClosed } = await copyWithTrouble({
        sourceClose: true
      })

      expect(outcome).toEqual({ savedAt: destinationPath, error: null })
      expect(targetClosed).toBe(true)
      expect(await fs.readFile(destinationPath, 'utf8')).toBe('copied')
    })

    it("reports the new file's lost write when both closes fail", async () => {
      const { destinationPath, outcome, targetClosed } = await copyWithTrouble({
        sourceClose: true,
        close: true
      })

      expect(targetClosed).toBe(true)
      expect(outcome.error?.message).toBe(stoppedPartway(destinationPath, CLOSE_ERROR))
    })

    it('reports the write failure over a later lost write on close', async () => {
      const { destinationPath, outcome, targetClosed } = await copyWithTrouble({
        write: true,
        close: true
      })

      expect(targetClosed).toBe(true)
      expect(outcome.error?.message).toBe(stoppedPartway(destinationPath, WRITE_ERROR))
    })
  })
})
