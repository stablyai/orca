import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const realpathNative = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, realpath: Object.assign(actual.realpath, { native: realpathNative }) }
})

import { wslMoveCutoverFixture as cutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoveJournalDirectory } from '../../persistence/moving-wsl-projects/cutover-recovery/wsl-move-cutover-journal'
import {
  isWslMoveProjectBlocked,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import {
  loadWslMappedDriveAnswers,
  wslMappedDriveAnswersPath
} from './wsl-mapped-drive-answers-file'
import {
  classifyWslMappedDrive,
  clearWslMappedDriveShareCacheForTests,
  readWslMappedDriveShareNow
} from './wsl-mapped-drive-share'
import { wslMappedDriveLastKnownShare } from './wsl-mapped-drive-last-known'

let userDataPath: string
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-drive-answers-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  resetWslMoveFenceForTests()
  clearWslMappedDriveShareCacheForTests()
  realpathNative.mockReset()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A fresh launch: memory gone, only the saved file left. */
function restart(): Promise<{ saved: () => Promise<void> }> {
  clearWslMappedDriveShareCacheForTests()
  return loadWslMappedDriveAnswers(userDataPath)
}

const fake = (real: string) => ({
  platform: 'win32' as const,
  realpathRoot: async () => real,
  now: () => 1_000,
  timeoutMs: 50
})

describe('saved mapped-drive answers', () => {
  it('keeps settled answers across restart and retains a WSL mapping after a failed lookup', async () => {
    const answers = await restart()
    await readWslMappedDriveShareNow('C', fake('C:\\'))
    await readWslMappedDriveShareNow('W', fake('\\\\wsl.localhost\\Ubuntu\\'))
    await answers.saved()
    expect(JSON.parse(readFileSync(wslMappedDriveAnswersPath(userDataPath), 'utf8'))).toEqual({
      version: 1,
      answers: [
        { letter: 'C', share: null, at: 1_000 },
        { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu', at: 1_000 }
      ]
    })
    const reloaded = await restart()
    expect(wslMappedDriveLastKnownShare('C')).toEqual({ share: null })
    expect(wslMappedDriveLastKnownShare('W')).toEqual({ share: '\\\\wsl.localhost\\Ubuntu' })
    expect(realpathNative).not.toHaveBeenCalled()

    const failing = {
      ...fake(''),
      realpathRoot: async (): Promise<string> => {
        throw new Error('ENOENT')
      }
    }
    await expect(readWslMappedDriveShareNow('W', failing)).resolves.toBe('unverifiable')
    await expect(classifyWslMappedDrive('W', { ...failing, now: () => 120_000 })).resolves.toEqual({
      share: '\\\\wsl.localhost\\Ubuntu'
    })
    await reloaded.saved()
    await restart()

    expect(wslMappedDriveLastKnownShare('W')).toEqual({ share: '\\\\wsl.localhost\\Ubuntu' })
    writeUnreadableJournal()
    loadWslMoveFence(userDataPath)
    expect(isWslMoveProjectBlocked(storeOf({ w: 'W:\\home\\me\\app' }), { repoId: 'w' })).toBe(true)
  })

  it('ignore a malformed file', async () => {
    writeFileSync(
      wslMappedDriveAnswersPath(userDataPath),
      '{"version":1,"answers":[{"letter":"cc"}]}'
    )
    await restart()
    expect(wslMappedDriveLastKnownShare('C')).toBeNull()
  })

  it('let an unreadable journal’s fence pass a C: project after a restart', async () => {
    const answers = await restart()
    await readWslMappedDriveShareNow('C', fake('C:\\'))
    await answers.saved()
    await restart()
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(
      join(wslMoveJournalDirectory(userDataPath), 'move-1.json'),
      JSON.stringify({ ...cutover('move-1', 'destination-committed'), version: 3 })
    )
    loadWslMoveFence(userDataPath)
    const store = {
      getRepo: (id: string) =>
        ({ c: { path: 'C:\\src\\site' }, w: { path: 'W:\\home\\me\\app' } })[id]
    }
    expect(isWslMoveProjectBlocked(store, { repoId: 'c' })).toBe(false)
    expect(isWslMoveProjectBlocked(store, { repoId: 'w' })).toBe(true)
    // C: is known from the file, so only the unknown W: is looked up.
    expect(realpathNative.mock.calls.map(([root]) => root)).toEqual(['W:\\'])
  })

  it('classify unknown letters once for an unreadable journal, never a saved WSL one', async () => {
    const answers = await restart()
    await readWslMappedDriveShareNow('W', fake('\\\\wsl.localhost\\Ubuntu\\'))
    await answers.saved()
    await restart()
    realpathNative.mockImplementation((root: string, done: (e: null, real: string) => void) =>
      done(null, root)
    )
    writeUnreadableJournal()
    loadWslMoveFence(userDataPath)
    const store = storeOf({ c: 'C:\\src\\site', w: 'W:\\home\\me\\app' })
    expect(isWslMoveProjectBlocked(store, { repoId: 'c' })).toBe(true)
    expect(isWslMoveProjectBlocked(store, { repoId: 'w' })).toBe(true)
    await vi.waitFor(() => expect(isWslMoveProjectBlocked(store, { repoId: 'c' })).toBe(false))
    expect(realpathNative.mock.calls.map(([root]) => root)).toEqual(['C:\\'])
    expect(isWslMoveProjectBlocked(store, { repoId: 'w' })).toBe(true)
  })

  it('skip the write when only an answer’s time changed, and clear stale temporaries', async () => {
    const stale = `${wslMappedDriveAnswersPath(userDataPath)}.999999.1.abc.tmp`
    writeFileSync(stale, 'x')
    utimesSync(stale, 0, 0)
    const answers = await restart()
    await answers.saved()
    expect(existsSync(stale)).toBe(false)
    await readWslMappedDriveShareNow('C', fake('C:\\'))
    await answers.saved()
    expect(existsSync(wslMappedDriveAnswersPath(userDataPath))).toBe(true)
    rmSync(wslMappedDriveAnswersPath(userDataPath))
    await readWslMappedDriveShareNow('C', { ...fake('C:\\'), now: () => 2_000 })
    await answers.saved()
    expect(existsSync(wslMappedDriveAnswersPath(userDataPath))).toBe(false)
  })
})

function writeUnreadableJournal(): void {
  mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
  writeFileSync(
    join(wslMoveJournalDirectory(userDataPath), 'move-1.json'),
    JSON.stringify({ ...cutover('move-1', 'destination-committed'), version: 3 })
  )
}

function storeOf(paths: Record<string, string>): {
  getRepo: (id: string) => { path: string } | undefined
} {
  return { getRepo: (id) => (id in paths ? { path: paths[id] } : undefined) }
}
