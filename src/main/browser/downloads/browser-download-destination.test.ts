import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

type FsCall = 'lstat' | 'mkdir' | 'realpath'
type FsWaitStep = { call: FsCall; path: string; run: () => void }
const fsWait = vi.hoisted((): { step: FsWaitStep | null } => ({ step: null }))
// Why: runs another main-thread task while a reservation waits on one fs call.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const during = (call: FsCall, filePath: string): void => {
    const step = fsWait.step
    if (step?.call === call && step.path === filePath) {
      fsWait.step = null
      step.run()
    }
  }
  return {
    ...actual,
    lstat: (filePath: string) => {
      during('lstat', filePath)
      return actual.lstat(filePath)
    },
    mkdir: (filePath: string, options: { recursive: true }) => {
      during('mkdir', filePath)
      return actual.mkdir(filePath, options)
    },
    realpath: (filePath: string) => {
      during('realpath', filePath)
      return actual.realpath(filePath)
    }
  }
})

const { BrowserDownloadDestinationReservations, splitBrowserDownloadRelativePath } =
  await import('./browser-download-destination')

let root: string
let downloads: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-download-destination-'))
  downloads = join(root, 'Downloads')
  mkdirSync(downloads)
})

afterEach(() => {
  fsWait.step = null
  rmSync(root, { recursive: true, force: true })
})

describe('splitBrowserDownloadRelativePath', () => {
  it('keeps folders and rejects absolute, drive, backslash and dot segments', () => {
    expect(
      [
        'App/s1/parts/part-0001.jsonl',
        'notes.txt',
        'Résumé/日本語 ノート.txt',
        'My Files/file name.txt'
      ].map(splitBrowserDownloadRelativePath)
    ).toEqual([
      ['App', 's1', 'parts', 'part-0001.jsonl'],
      ['notes.txt'],
      ['Résumé', '日本語 ノート.txt'],
      ['My Files', 'file name.txt']
    ])
    expect(
      [
        '/etc/passwd',
        'C:/x.txt',
        'c:x.txt',
        'App\\..\\x',
        '\\\\server\\share',
        'App/../x',
        './x',
        'App//x',
        'App/',
        ' ',
        '',
        '.',
        '..',
        'App/ .. /x'
      ].map(splitBrowserDownloadRelativePath)
    ).toEqual(Array(14).fill(null))
  })
})

describe('BrowserDownloadDestinationReservations', () => {
  const refusal = 'Another download is already saving to this file.'

  it('reserves a nested overwrite at its exact path for one download at a time', async () => {
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const parts = join(downloads, 'App', 's1', 'parts')
    mkdirSync(parts, { recursive: true })
    writeFileSync(join(parts, 'part-0001.jsonl'), 'old')
    const nested = { directories: ['App', 's1', 'parts'], overwrite: true }

    const first = await reservations.reserveTarget('part-0001.jsonl', nested)
    expect(first.savePath).toBe(join(parts, 'part-0001.jsonl'))
    await expect(reservations.reserveTarget('part-0001.jsonl', nested)).rejects.toThrow(refusal)
    reservations.release(first.reservationKey)
    expect((await reservations.reserveTarget('part-0001.jsonl', nested)).savePath).toBe(
      join(parts, 'part-0001.jsonl')
    )

    expect(
      await reservations.reserveTarget('COMPLETE.json', {
        directories: ['App', 's2'],
        overwrite: true
      })
    ).toMatchObject({ savePath: join(downloads, 'App', 's2', 'COMPLETE.json') })
    expect(existsSync(join(downloads, 'App', 's2'))).toBe(true)
    expect(
      await reservations.reserveTarget('part-0001.jsonl', { directories: ['App', 's1', 'parts'] })
    ).toMatchObject({ savePath: join(parts, 'part-0001 (1).jsonl') })
  })

  it('refuses a folder that a symlink leads outside Downloads, but follows a symlinked Downloads', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(downloads, 'App'), 'junction')
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })

    await expect(
      reservations.reserveTarget('a.txt', { directories: ['App', 's1'] })
    ).rejects.toThrow('The download folder leads outside Downloads.')
    expect(readdirSync(outside)).toEqual([])

    const linkedDownloads = join(root, 'LinkedDownloads')
    symlinkSync(downloads, linkedDownloads, 'junction')
    const linked = new BrowserDownloadDestinationReservations({ downloadsPath: linkedDownloads })
    expect(
      (await linked.reserveTarget('a.txt', { directories: ['Safe'], overwrite: true })).savePath
    ).toBe(join(linkedDownloads, 'Safe', 'a.txt'))
  })

  it('treats a plain name and a top-level target as one file, even through a symlinked Downloads', async () => {
    const linkedDownloads = join(root, 'LinkedDownloads')
    symlinkSync(downloads, linkedDownloads, 'junction')
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath: linkedDownloads
    })

    reservations.reserve('a.txt')
    await expect(reservations.reserveTarget('a.txt', { overwrite: true })).rejects.toThrow(refusal)
    await reservations.reserveTarget('b.txt', { overwrite: true })
    expect(reservations.reserve('b.txt').savePath).toBe(join(linkedDownloads, 'b (1).txt'))
  })

  it('treats folder paths that a symlink joins as one place when reserving', async () => {
    mkdirSync(join(downloads, 'actual'))
    symlinkSync(join(downloads, 'actual'), join(downloads, 'alias'), 'junction')
    symlinkSync(downloads, join(downloads, 'here'), 'junction')
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const actual = { directories: ['actual'], overwrite: true }
    const alias = { directories: ['alias'], overwrite: true }

    const first = await reservations.reserveTarget('a.txt', actual)
    await expect(reservations.reserveTarget('a.txt', alias)).rejects.toThrow(refusal)
    expect((await reservations.reserveTarget('a.txt', { directories: ['alias'] })).savePath).toBe(
      join(downloads, 'alias', 'a (1).txt')
    )
    reservations.release(first.reservationKey)
    expect((await reservations.reserveTarget('a.txt', alias)).savePath).toBe(
      join(downloads, 'alias', 'a.txt')
    )

    expect(reservations.reserve('b.txt').savePath).toBe(join(downloads, 'b.txt'))
    await expect(
      reservations.reserveTarget('b.txt', { directories: ['here'], overwrite: true })
    ).rejects.toThrow(refusal)
  })

  it('gives concurrent targets of one name different files', async () => {
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const app = { directories: ['App'] }

    const reserved = await Promise.all([
      reservations.reserveTarget('a.txt', app),
      reservations.reserveTarget('a.txt', app)
    ])
    expect(reserved.map(({ savePath }) => savePath).sort()).toEqual([
      join(downloads, 'App', 'a (1).txt'),
      join(downloads, 'App', 'a.txt')
    ])
  })

  it('lets only one of concurrent overwrites of a file save', async () => {
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const app = { directories: ['App'], overwrite: true }

    const results = await Promise.allSettled([
      reservations.reserveTarget('a.txt', app),
      reservations.reserveTarget('a.txt', app)
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')?.reason).toEqual(
      new Error(refusal)
    )
  })

  it('creates no folder for a refused save, and keeps reservations when Downloads appears under a symlinked parent', async () => {
    const actualParent = join(root, 'actualParent')
    mkdirSync(actualParent)
    const aliasParent = join(root, 'aliasParent')
    symlinkSync(actualParent, aliasParent, 'junction')
    const missing = join(aliasParent, 'Downloads')
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: missing })

    const flat = reservations.reserve('same.txt')
    await expect(reservations.reserveTarget('same.txt', { overwrite: true })).rejects.toThrow(
      refusal
    )
    expect(existsSync(missing)).toBe(false)
    // Another save creates Downloads; the flat save must still hold its file.
    await reservations.reserveTarget('other.txt', { overwrite: true })
    expect(existsSync(missing)).toBe(true)
    await expect(reservations.reserveTarget('same.txt', { overwrite: true })).rejects.toThrow(
      refusal
    )
    expect(reservations.reserve('same.txt').savePath).toBe(join(missing, 'same (1).txt'))

    reservations.release(flat.reservationKey)
    expect((await reservations.reserveTarget('same.txt', { overwrite: true })).savePath).toBe(
      join(missing, 'same.txt')
    )
  })

  it.each([
    { wait: 'the folder walk', call: 'realpath' as const, file: '', overwrite: true },
    { wait: 'the overwrite check', call: 'lstat' as const, file: 'a.txt', overwrite: true },
    { wait: 'the name probe', call: 'lstat' as const, file: 'a.txt', overwrite: false }
  ])('drops a target that a reset interrupts during $wait', async ({ call, file, overwrite }) => {
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const app = join(downloads, 'App')
    fsWait.step = {
      call,
      path: file ? join(app, file) : downloads,
      run: () => reservations.clear()
    }

    await expect(
      reservations.reserveTarget('a.txt', { directories: ['App'], overwrite })
    ).rejects.toThrow('Downloads were reset while this file was being reserved.')
    expect(existsSync(app)).toBe(false)
    expect(
      (await reservations.reserveTarget('a.txt', { directories: ['App'], overwrite: true }))
        .savePath
    ).toBe(join(app, 'a.txt'))
  })

  it('drops a target that a reset interrupts while its folder is created', async () => {
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const app = { directories: ['App'] }
    let successor: Promise<{ savePath: string }> | undefined
    fsWait.step = {
      call: 'mkdir',
      path: join(downloads, 'App'),
      run: () => {
        reservations.clear()
        successor = reservations.reserveTarget('a.txt', app)
      }
    }

    await expect(reservations.reserveTarget('a.txt', app)).rejects.toThrow(
      'Downloads were reset while this file was being reserved.'
    )
    expect((await successor)?.savePath).toBe(join(downloads, 'App', 'a.txt'))
  })

  it('keeps a later reservation when a reset one fails to create its folder', async () => {
    writeFileSync(join(root, 'file'), '')
    const blocked = join(root, 'file', 'Downloads')
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: blocked })
    let successor = ''
    fsWait.step = {
      call: 'mkdir',
      path: blocked,
      run: () => {
        reservations.clear()
        successor = reservations.reserve('a.txt').filename
      }
    }

    await expect(reservations.reserveTarget('a.txt', { overwrite: true })).rejects.toThrow(
      'Could not create the download folder.'
    )
    expect(successor).toBe('a.txt')
    expect(reservations.reserve('a.txt').filename).toBe('a (1).txt')
  })

  it('says a reservation holds its file only until it is released, reset or taken over', async () => {
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const released = reservations.reserve('a.txt').reservationKey
    reservations.release(released)
    const reset = (await reservations.reserveTarget('a.txt', { overwrite: true })).reservationKey
    expect(reservations.holds(reset)).toBe(true)

    reservations.clear()
    const successor = reservations.reserve('a.txt').reservationKey
    expect([released, reset, null].map((key) => reservations.holds(key))).toEqual([
      false,
      false,
      false
    ])
    expect(reservations.holds(successor)).toBe(true)
  })

  it('frees the file when its folder cannot be created', async () => {
    writeFileSync(join(downloads, 'App'), 'not a folder')
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
    const target = { directories: ['App'], overwrite: true }

    await expect(reservations.reserveTarget('a.txt', target)).rejects.toThrow(
      'Could not create the download folder.'
    )
    rmSync(join(downloads, 'App'))
    expect((await reservations.reserveTarget('a.txt', target)).savePath).toBe(
      join(downloads, 'App', 'a.txt')
    )
  })

  it('treats names that differ only in case as one file on Windows', async () => {
    const windows = new BrowserDownloadDestinationReservations({
      downloadsPath: downloads,
      platform: 'win32'
    })
    await windows.reserveTarget('Notes.txt', { directories: ['App'], overwrite: true })
    await expect(
      windows.reserveTarget('notes.TXT', { directories: ['app'], overwrite: true })
    ).rejects.toThrow(refusal)
  })

  it('treats NFC and NFD spellings of a name as one file on macOS', async () => {
    const mac = new BrowserDownloadDestinationReservations({
      downloadsPath: downloads,
      platform: 'darwin'
    })
    await mac.reserveTarget('caf\u00e9.txt', { directories: ['App'], overwrite: true })
    await expect(
      mac.reserveTarget('cafe\u0301.txt', { directories: ['App'], overwrite: true })
    ).rejects.toThrow(refusal)
  })

  it.skipIf(process.platform === 'win32')(
    'never saves through a dangling symlink, nor overwrites a folder or a symlinked file',
    async () => {
      const safe = join(downloads, 'Safe')
      mkdirSync(safe)
      mkdirSync(join(downloads, 'folder.txt'))
      symlinkSync(join(root, 'outside.txt'), join(safe, 'a.txt'))
      symlinkSync(join(root, 'outside.txt'), join(downloads, 'b.txt'))
      const reservations = new BrowserDownloadDestinationReservations({ downloadsPath: downloads })
      const overwriteRefusal = 'Only a regular file in Downloads can be overwritten.'

      await expect(reservations.reserveTarget('folder.txt', { overwrite: true })).rejects.toThrow(
        overwriteRefusal
      )
      await expect(
        reservations.reserveTarget('a.txt', { directories: ['Safe'], overwrite: true })
      ).rejects.toThrow(overwriteRefusal)
      expect((await reservations.reserveTarget('a.txt', { directories: ['Safe'] })).savePath).toBe(
        join(safe, 'a (1).txt')
      )
      expect(reservations.reserve('b.txt').savePath).toBe(join(downloads, 'b (1).txt'))
    }
  )
})
