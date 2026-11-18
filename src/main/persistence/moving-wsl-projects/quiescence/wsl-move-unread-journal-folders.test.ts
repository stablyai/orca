/** A journal this build can't read (corrupt, or from a newer build) still fences moved W:\ rows. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import {
  clearWslMappedDriveShareCacheForTests,
  readWslMappedDriveShareNow
} from '../../../wsl/filesystem/wsl-mapped-drive-share'
import { wslMoveJournalDirectory } from '../cutover-recovery/wsl-move-cutover-journal'
import {
  isWslMoveCwdFenced,
  isWslMoveProjectBlocked,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from './wsl-move-scope-guard'

let userDataPath: string
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-unread-'))
  const record = cutover('move-1', 'destination-committed', {
    mappedDrives: [{ letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }]
  })
  mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
  // A version this build doesn't know: the whole journal reads as unreadable.
  writeFileSync(
    join(wslMoveJournalDirectory(userDataPath), 'move-1.json'),
    JSON.stringify({ ...record, version: 3 })
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  resetWslMoveFenceForTests()
  clearWslMappedDriveShareCacheForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const repos = [
  { id: 'moved-w', path: 'W:\\home\\dev\\repo-1' },
  { id: 'local-c', path: 'C:\\src\\site' },
  { id: 'unc', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\other' }
]
const store = { getRepo: (id: string) => repos.find((repo) => repo.id === id) }

describe('an unreadable WSL move journal', () => {
  it('blocks drive-letter rows not known to be outside WSL, and their terminals', async () => {
    // C: has answered as a local disk before; W: never has.
    await readWslMappedDriveShareNow('C', {
      platform: 'win32',
      realpathRoot: async () => 'C:\\',
      now: () => 0,
      timeoutMs: 50
    })
    loadWslMoveFence(userDataPath)
    expect(isWslMoveProjectBlocked(store, { repoId: 'moved-w' })).toBe(true)
    expect(isWslMoveProjectBlocked(store, { repoId: 'unc' })).toBe(true)
    expect(isWslMoveProjectBlocked(store, { repoId: 'local-c' })).toBe(false)
    expect(isWslMoveCwdFenced('W:\\home\\dev\\repo-1\\src')).toBe(true)
    expect(isWslMoveCwdFenced('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1')).toBe(true)
    expect(isWslMoveCwdFenced('C:\\src\\site')).toBe(false)
  })

  it('still blocks a drive last known to map into WSL', async () => {
    await readWslMappedDriveShareNow('W', {
      platform: 'win32',
      realpathRoot: async () => '\\\\wsl.localhost\\Ubuntu\\',
      now: () => 0,
      timeoutMs: 50
    })
    loadWslMoveFence(userDataPath)
    expect(isWslMoveProjectBlocked(store, { repoId: 'moved-w' })).toBe(true)
  })

  it('never treats a drive letter as WSL off Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    loadWslMoveFence(userDataPath)
    expect(isWslMoveProjectBlocked(store, { repoId: 'moved-w' })).toBe(false)
    expect(isWslMoveCwdFenced('W:\\home\\dev\\repo-1')).toBe(false)
    expect(isWslMoveProjectBlocked(store, { repoId: 'unc' })).toBe(true)
  })
})
