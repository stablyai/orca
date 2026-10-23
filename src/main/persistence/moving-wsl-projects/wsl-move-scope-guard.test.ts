import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { removeWslMoveCutover, wslMoveJournalDirectory } from './wsl-move-cutover-journal'
import {
  WslMoveProjectFencedError,
  assertWslMoveProjectWritable,
  assertWslMoveRepoWritable,
  assertWslMoveReposWritable,
  assertWslMoveWorkspaceWritable,
  isPassiveWorkspaceUpdate,
  isWslMoveFenceLoaded,
  isWslMoveProjectBlocked,
  isWslMoveProjectFenced,
  isWslMoveSourceHost,
  loadWslMoveFence,
  shouldDropWslMoveProjectUpdate,
  resetWslMoveFenceForTests,
  withoutWslMovedFolderWorkspaces,
  withoutWslMovedRepos,
  wslMoveProjectRefForWorkspace
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

describe('wslMoveProjectRefForWorkspace', () => {
  it.each([
    ['repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app', { repoId: 'repo-1' }],
    ['worktree:repo-1::/home/dev/app', { repoId: 'repo-1' }],
    ['folder:notes', { folderWorkspaceId: 'notes' }],
    ['repo-1::/home/dev/app::workspace:7f3c', { repoId: 'repo-1' }],
    ['repo-1::/home/dev/a::b', { repoId: 'repo-1' }],
    ['bare-id', null]
  ])('%s', (key, expected) => {
    expect(wslMoveProjectRefForWorkspace(key)).toEqual(expected)
  })
})

describe('WSL move scope guard', () => {
  it('fences nothing before startup loads the journal', () => {
    resetWslMoveFenceForTests()
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(isWslMoveFenceLoaded()).toBe(false)
    expect(writable('repo-1::/x')).not.toThrow()
  })

  it('follows a write under another spelling of the same profile folder', () => {
    loadWslMoveFence(`${userDataPath}/./`)
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
  })

  it('lifts the fence when the finished move is removed', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(writable('repo-1::/x')).not.toThrow()
  })

  it('never matches a project on another host', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(writable('ssh:target-1|repo-1::/x')).not.toThrow()
  })

  it('follows journal writes without rereading on every check', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    rmSync(wslMoveJournalDirectory(userDataPath), { recursive: true, force: true })
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
  })

  it('lets every project through when no move is recorded', () => {
    expect(writable('repo-1::/x')).not.toThrow()
    expect(withoutWslMovedRepos([{ id: 'repo-1' }])).toHaveLength(1)
  })

  it('leaves a prepared move untouched', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    expect(writable('repo-1::/x')).not.toThrow()
  })

  it('refuses work in a fenced project and keeps it listed', () => {
    seedWslMoveCutover(
      userDataPath,
      cutover('move-1', 'source-fenced', {}, { repoIds: ['repo-1'], folderWorkspaceIds: ['notes'] })
    )
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    expect(writable('folder:notes')).toThrow(WslMoveProjectFencedError)
    expect(writable('repo-2::/x')).not.toThrow()
    const rows = [{ id: 'repo-1' }, { id: 'repo-2' }]
    expect(withoutWslMovedRepos(rows)).toEqual(rows)
  })

  it('hides and refuses a project the WSL host owns', () => {
    seedWslMoveCutover(
      userDataPath,
      cutover('move-1', 'destination-committed', {}, { folderWorkspaceIds: ['notes'] })
    )
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    expect(withoutWslMovedFolderWorkspaces([{ id: 'notes' }, { id: 'other' }])).toEqual([
      { id: 'other' }
    ])
  })

  it("keeps the host's own row, which carries the moved project's id", () => {
    seedWslMoveCutover(
      userDataPath,
      cutover('move-1', 'destination-committed', {}, { repoIds: ['repo-1'] })
    )
    const onHost = { id: 'repo-1', executionHostId: 'runtime:wsl:ubuntu' }
    const viaSsh = { id: 'repo-1', connectionId: 'target-1' }
    expect(withoutWslMovedRepos([{ id: 'repo-1' }, onHost, viaSsh])).toEqual([onHost, viaSsh])
  })

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
  const fenceRepo1AndNotes = () =>
    seedWslMoveCutover(
      userDataPath,
      cutover('move-1', 'source-fenced', {}, { repoIds: ['repo-1'], folderWorkspaceIds: ['notes'] })
    )

  it.each([
    [{ isUnread: true, lastActivityAt: 1 }, true],
    [{ lastActivityAt: 1 }, true],
    [{ isUnread: false }, true],
    [{ isUnread: true }, false],
    [{}, false],
    [{ isUnread: true, displayName: 'x' }, false],
    [{ comment: 'x' }, false]
  ])('treats %o as passive: %s', (updates, passive) => {
    expect(isPassiveWorkspaceUpdate(updates)).toBe(passive)
  })

  it('drops passive updates to a blocked project and refuses user edits', () => {
    fenceRepo1AndNotes()
    const notes = { folderWorkspaceId: 'notes' }
    expect(shouldDropWslMoveProjectUpdate(undefined, notes, { isUnread: false })).toBe(true)
    expect(() => shouldDropWslMoveProjectUpdate(undefined, notes, { isUnread: true })).toThrow(
      WslMoveProjectFencedError
    )
    expect(() => shouldDropWslMoveProjectUpdate(undefined, notes, { name: 'x' })).toThrow(
      WslMoveProjectFencedError
    )
    expect(shouldDropWslMoveProjectUpdate(undefined, { repoId: 'repo-2' }, { name: 'x' })).toBe(
      false
    )
  })

  it('refuses a blocked project, and a catalog project when any source repo is blocked', () => {
    fenceRepo1AndNotes()
    expect(() => assertWslMoveProjectWritable(undefined, { repoId: 'repo-1' })).toThrow(
      WslMoveProjectFencedError
    )
    expect(() => assertWslMoveProjectWritable(undefined, { repoId: 'repo-2' })).not.toThrow()
    expect(() => assertWslMoveReposWritable(undefined, ['repo-2', 'repo-1'])).toThrow(
      WslMoveProjectFencedError
    )
    expect(() => assertWslMoveReposWritable(undefined, ['repo-2'])).not.toThrow()
  })

  it('freezes catalog settings only while a source repo is mid-move', () => {
    seedWslMoveCutover(
      userDataPath,
      cutover('move-1', 'destination-committed', {}, { repoIds: ['repo-1'] })
    )
    expect(isWslMoveProjectFenced(undefined, { repoId: 'repo-1' })).toBe(false)
    expect(isWslMoveProjectBlocked(undefined, { repoId: 'repo-1' })).toBe(true)
    expect(() => assertWslMoveReposWritable(undefined, ['repo-1', 'repo-2'])).not.toThrow()
  })

  it('only fences a repo row that runs on this machine', () => {
    fenceRepo1AndNotes()
    expect(isWslMoveSourceHost(undefined)).toBe(true)
    expect(isWslMoveSourceHost('local')).toBe(true)
    expect(isWslMoveSourceHost('ssh:box')).toBe(false)
    expect(() => assertWslMoveRepoWritable(undefined, { id: 'repo-1' })).toThrow(
      WslMoveProjectFencedError
    )
    expect(() =>
      assertWslMoveRepoWritable(undefined, { id: 'repo-1', executionHostId: 'ssh:box' })
    ).not.toThrow()
  })

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
