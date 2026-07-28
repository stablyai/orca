import { describe, expect, it } from 'vitest'
import {
  listFolderWorkspaceChildRepos,
  matchFolderWorkspaceChildRepo,
  mergeFolderWorkspaceGitStatus,
  prefixFolderWorkspaceEntryPath
} from './folder-workspace-child-repos'
import type { GitStatusResult, Repo } from '../../shared/types'

function repo(id: string, path: string, kind: 'folder' | 'git' = 'git'): Repo {
  return { id, path, displayName: id, badgeColor: 'blue', addedAt: 1, kind, connectionId: null }
}

const FOLDER = '/work/fint'
const API = repo('api', '/work/fint/fint_api')
const PORTAL = repo('portal', '/work/fint/fint-portal')
const NESTED = repo('nested', '/work/fint/fint_api/vendor/sdk')
const CONTAINER = repo('container', FOLDER, 'folder')
const OUTSIDE = repo('outside', '/work/other')

function status(entries: GitStatusResult['entries']): GitStatusResult {
  return { entries, conflictOperation: 'unknown' }
}

describe('listFolderWorkspaceChildRepos', () => {
  it('keeps only git repos inside the folder, deepest first', () => {
    const found = listFolderWorkspaceChildRepos([API, CONTAINER, OUTSIDE, NESTED, PORTAL], FOLDER)
    expect(found.map((entry) => entry.id)).toEqual(['nested', 'portal', 'api'])
  })

  it('excludes the folder repo itself even when registered as a git repo', () => {
    expect(listFolderWorkspaceChildRepos([repo('self', FOLDER)], FOLDER)).toEqual([])
  })

  it('orders deepest-first by normalized path, not raw string length', () => {
    // Why: `\\wsl$\...\repo\nested` (30 chars) is shorter than its own ancestor
    // `\\wsl.localhost\...\repo` (32) even though it is one level deeper. Sorting
    // on raw length puts the ancestor first and routes the nested repo's files
    // to it. Both spellings normalize to the same //wsl/ubuntu root.
    const wslFolder = '\\\\wsl.localhost\\Ubuntu\\work'
    const ancestor = repo('ancestor', '\\\\wsl.localhost\\Ubuntu\\work\\repo')
    const nested = repo('nested-wsl', '\\\\wsl$\\Ubuntu\\work\\repo\\nested')
    expect(ancestor.path.length).toBeGreaterThan(nested.path.length)
    expect(
      listFolderWorkspaceChildRepos([ancestor, nested], wslFolder).map((entry) => entry.id)
    ).toEqual(['nested-wsl', 'ancestor'])
  })

  it('routes a file to the nested repo when the two spell the WSL host differently', () => {
    const wslFolder = '\\\\wsl.localhost\\Ubuntu\\work'
    const ancestor = repo('ancestor', '\\\\wsl.localhost\\Ubuntu\\work\\repo')
    const nested = repo('nested-wsl', '\\\\wsl$\\Ubuntu\\work\\repo\\nested')
    const match = matchFolderWorkspaceChildRepo(
      [ancestor, nested],
      wslFolder,
      'repo/nested/src/app.ts'
    )
    expect(match?.repo.id).toBe('nested-wsl')
    expect(match?.rebasedRelativePath).toBe('src/app.ts')
  })

  it('keeps one entry when the same directory is registered twice', () => {
    // Why: a duplicate registration would list every file twice in the merged
    // status and run the commit against that repo twice.
    const dupe = repo('api-again', API.path)
    expect(listFolderWorkspaceChildRepos([API, dupe], FOLDER).map((e) => e.id)).toEqual(['api'])
  })
})

describe('matchFolderWorkspaceChildRepo', () => {
  it('routes a workspace-relative path to its owning repo', () => {
    expect(matchFolderWorkspaceChildRepo([API, PORTAL], FOLDER, 'fint_api/src/app.ts')).toEqual({
      repo: API,
      rebasedRelativePath: 'src/app.ts'
    })
  })

  it('prefers the deepest repo when repos are nested', () => {
    const match = matchFolderWorkspaceChildRepo([API, NESTED], FOLDER, 'fint_api/vendor/sdk/x.ts')
    expect(match).toEqual({ repo: NESTED, rebasedRelativePath: 'x.ts' })
  })

  it('returns null without a path, so callers do not silently pick a repo', () => {
    expect(matchFolderWorkspaceChildRepo([API], FOLDER, undefined)).toBeNull()
  })

  it('refuses a path that escapes the workspace folder', () => {
    expect(matchFolderWorkspaceChildRepo([API, OUTSIDE], FOLDER, '../other/x.ts')).toBeNull()
  })

  it('routes a `..` path that normalizes back inside the workspace', () => {
    // Why: normalization, not the escape guard, is what decides this. A path can
    // only reach a child repo if it is already inside the folder, since child repos
    // are filtered to the folder — so the guard rejects nothing a match would have
    // accepted. It stays as defense-in-depth if that filter ever changes.
    expect(
      matchFolderWorkspaceChildRepo([API], FOLDER, 'fint_api/../../fint/fint_api/src/app.ts')
    ).toEqual({ repo: API, rebasedRelativePath: 'src/app.ts' })
  })

  it('returns null for a path in the folder but outside every child repo', () => {
    expect(matchFolderWorkspaceChildRepo([API], FOLDER, 'README.md')).toBeNull()
  })

  it('returns null for the repo root itself, which addresses no file', () => {
    expect(matchFolderWorkspaceChildRepo([API], FOLDER, 'fint_api')).toBeNull()
  })

  it('refuses a nested repo root instead of routing it to the ancestor repo', () => {
    // Why: the ancestor reports a nested repo as one untracked dir (`? vendor/sdk/`),
    // so this path is reachable from the merged status. Routing it to the ancestor
    // makes discard run `git clean -ffdx` over the nested repo — .git and all.
    expect(matchFolderWorkspaceChildRepo([API, NESTED], FOLDER, 'fint_api/vendor/sdk')).toBeNull()
  })
})

describe('prefixFolderWorkspaceEntryPath', () => {
  it('makes a child-repo path addressable from the workspace root', () => {
    expect(prefixFolderWorkspaceEntryPath(FOLDER, API.path, 'src/app.ts')).toBe(
      'fint_api/src/app.ts'
    )
  })
})

describe('mergeFolderWorkspaceGitStatus', () => {
  it('rewrites every entry path workspace-relative', () => {
    const merged = mergeFolderWorkspaceGitStatus(FOLDER, [
      { repo: API, status: status([{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]) },
      { repo: PORTAL, status: status([{ path: 'a.ts', status: 'untracked', area: 'untracked' }]) }
    ])
    expect(merged.entries.map((entry) => entry.path)).toEqual([
      'fint_api/src/app.ts',
      'fint-portal/a.ts'
    ])
  })

  it('rewrites oldPath and submoduleRoot alongside path', () => {
    const merged = mergeFolderWorkspaceGitStatus(FOLDER, [
      {
        repo: API,
        status: status([
          { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', area: 'staged' },
          { path: 'sub/f.ts', status: 'modified', area: 'unstaged', submoduleRoot: 'sub' }
        ])
      }
    ])
    expect(merged.entries[0].oldPath).toBe('fint_api/old.ts')
    expect(merged.entries[1].submoduleRoot).toBe('fint_api/sub')
  })

  it('leaves head, branch and upstream unset because no single repo owns them', () => {
    const merged = mergeFolderWorkspaceGitStatus(FOLDER, [
      {
        repo: API,
        status: { ...status([]), head: 'abc', branch: 'master', upstreamStatus: undefined }
      }
    ])
    expect(merged.head).toBeUndefined()
    expect(merged.branch).toBeUndefined()
    expect(merged.upstreamStatus).toBeUndefined()
  })

  it('surfaces a conflict when exactly one child repo has one', () => {
    const merged = mergeFolderWorkspaceGitStatus(FOLDER, [
      { repo: API, status: status([]) },
      { repo: PORTAL, status: { entries: [], conflictOperation: 'rebase' } }
    ])
    expect(merged.conflictOperation).toBe('rebase')
  })

  it('reports unknown when two child repos are conflicted', () => {
    // Why: "rebase" here would offer one abort button for two repos, and it would
    // silently mean whichever repo happened to come first.
    const merged = mergeFolderWorkspaceGitStatus(FOLDER, [
      { repo: API, status: { entries: [], conflictOperation: 'merge' } },
      { repo: PORTAL, status: { entries: [], conflictOperation: 'rebase' } }
    ])
    expect(merged.conflictOperation).toBe('unknown')
  })

  it('propagates a truncation flag so the UI still warns', () => {
    const merged = mergeFolderWorkspaceGitStatus(FOLDER, [
      { repo: API, status: { ...status([]), didHitLimit: true, statusLength: 9000 } },
      { repo: PORTAL, status: { ...status([]), statusLength: 5 } }
    ])
    expect(merged.didHitLimit).toBe(true)
    expect(merged.statusLength).toBe(9005)
  })

  it('returns an empty result rather than throwing when no child repo reported', () => {
    expect(mergeFolderWorkspaceGitStatus(FOLDER, [])).toEqual({
      entries: [],
      conflictOperation: 'unknown',
      statusLength: 0
    })
  })
})
