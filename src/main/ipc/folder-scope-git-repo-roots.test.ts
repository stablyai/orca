import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFolderScopeGitRepoRoot } from './folder-scope-git-repo-roots'

const FOLDER_ROOT = path.resolve('/workspace/meta')
const CHILD_REPO = path.join(FOLDER_ROOT, 'engine')

describe('resolveFolderScopeGitRepoRoot', () => {
  it('authorizes a git repo that is an immediate child of a folder-scope root', () => {
    expect(resolveFolderScopeGitRepoRoot(CHILD_REPO, [FOLDER_ROOT], () => true)).toBe(CHILD_REPO)
  })

  it('denies a child that is not a git repo', () => {
    expect(resolveFolderScopeGitRepoRoot(CHILD_REPO, [FOLDER_ROOT], () => false)).toBeNull()
  })

  it('denies paths nested deeper than one level', () => {
    const nested = path.join(CHILD_REPO, 'packages', 'core')
    expect(resolveFolderScopeGitRepoRoot(nested, [FOLDER_ROOT], () => true)).toBeNull()
  })

  it('authorizes the folder root itself when the folder is a git repo', () => {
    expect(resolveFolderScopeGitRepoRoot(FOLDER_ROOT, [FOLDER_ROOT], () => true)).toBe(FOLDER_ROOT)
  })

  it('denies the folder root when it is not a git repo, and unrelated paths', () => {
    expect(resolveFolderScopeGitRepoRoot(FOLDER_ROOT, [FOLDER_ROOT], () => false)).toBeNull()
    const elsewhere = path.resolve('/workspace/other/engine')
    expect(resolveFolderScopeGitRepoRoot(elsewhere, [FOLDER_ROOT], () => true)).toBeNull()
  })

  it('denies a directory inside a repo that is not the repo root', () => {
    const inner = path.join(FOLDER_ROOT, 'src')
    const isRepoRoot = (candidate: string) => candidate === FOLDER_ROOT
    expect(resolveFolderScopeGitRepoRoot(inner, [FOLDER_ROOT], isRepoRoot)).toBeNull()
  })

  it('never probes git for paths outside every folder-scope root', () => {
    let probed = false
    const elsewhere = path.resolve('/workspace/other/engine')
    resolveFolderScopeGitRepoRoot(elsewhere, [FOLDER_ROOT], () => {
      probed = true
      return true
    })
    expect(probed).toBe(false)
  })

  it('returns null when there are no folder-scope roots', () => {
    expect(resolveFolderScopeGitRepoRoot(CHILD_REPO, [], () => true)).toBeNull()
  })
})
