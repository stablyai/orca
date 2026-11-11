import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveJournalDirectory } from '../cutover-recovery/wsl-move-cutover-journal'
import {
  WslMoveProjectFencedError,
  assertWslMoveWorkspaceWritable,
  isWslMoveProjectBlocked,
  loadWslMoveFence,
  resetWslMoveFenceForTests,
  withoutWslMovedRepos
} from './wsl-move-scope-guard'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-guard-'))
  loadWslMoveFence(userDataPath)
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const repoPaths = new Map([
  ['repo-wsl', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'],
  ['repo-win', 'C:\\src\\app']
])
const store = {
  getRepo: (id: string) => {
    const path = repoPaths.get(id)
    return path === undefined ? undefined : { path }
  },
  getFolderWorkspace: () => undefined
}
const writable = (workspaceId: string) => () => assertWslMoveWorkspaceWritable(store, workspaceId)

describe('WSL move scope guard', () => {
  it('keeps WSL projects read-only and every row listed when the journal is unreadable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const directory = wslMoveJournalDirectory(userDataPath)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'move-1.json'), '{not json')
    loadWslMoveFence(userDataPath)
    expect(writable('repo-wsl::/x')).toThrow(WslMoveProjectFencedError)
    expect(writable('repo-win::/x')).not.toThrow()
    const rows = [{ id: 'repo-wsl' }]
    expect(withoutWslMovedRepos(rows)).toEqual(rows)
  })
})

describe('WSL move edit guard', () => {
  it('finds a folder path through the list when the store has no single lookup', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const directory = wslMoveJournalDirectory(userDataPath)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'move-1.json'), '{not json')
    loadWslMoveFence(userDataPath)
    const listOnly = {
      getRepo: () => undefined,
      getFolderWorkspaces: () => [
        { id: 'wsl-notes', folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\notes' },
        { id: 'win-notes', folderPath: 'C:\\notes' }
      ]
    }
    expect(isWslMoveProjectBlocked(listOnly, { folderWorkspaceId: 'wsl-notes' })).toBe(true)
    expect(isWslMoveProjectBlocked(listOnly, { folderWorkspaceId: 'win-notes' })).toBe(false)
    expect(isWslMoveProjectBlocked({ getRepo: () => undefined }, { folderWorkspaceId: 'x' })).toBe(
      false
    )
  })
})
