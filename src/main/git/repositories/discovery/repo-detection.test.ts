import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  inspectFolderToGitConversion,
  proveRepoKindChange
} from '../../../workspaces/catalog/folder-repo-git-conversion'
import { inspectGitRepoForRegistrationAsync, isGitRepo } from './repo-detection'
import { setLocalGitRuntimeRouter } from '../../command-runner/host-routing/local-git-runtime-route'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-dubious-ownership-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  // Real Git reports dubious ownership without a second OS user.
  vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1')
  // A host-level `safe.directory = *` would otherwise trust the repo.
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterEach(() => {
  setLocalGitRuntimeRouter(null)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it('reports Git ownership refusals instead of accepting the .git marker', async () => {
  expect(await inspectGitRepoForRegistrationAsync(root)).toEqual({
    isRepo: false,
    ownershipError: expect.stringMatching(
      /^Git detected dubious ownership in repository at [\s\S]*\n\tgit config --global --add safe\.directory \S/
    ),
    rootPath: root,
    mainRepoPath: null
  })
  expect(isGitRepo(root)).toBe(false)
  const folderProject = {
    id: 'r1',
    path: root,
    displayName: 'r1',
    badgeColor: '',
    addedAt: 0,
    kind: 'folder' as const
  }
  await expect(proveRepoKindChange(folderProject, 'git')).rejects.toThrow(/safe\.directory/)
})

it('converts a refused folder once the user trusts it, with the .git marker unchanged', async () => {
  expect(await inspectFolderToGitConversion(root)).toEqual({
    conversion: null,
    ownershipError: expect.stringContaining('safe.directory')
  })
  writeFileSync(join(root, 'gitconfig'), '[safe]\n\tdirectory = *\n')
  expect((await inspectFolderToGitConversion(root)).conversion).not.toBeNull()
})

it('keeps the .git marker fallback while the WSL-hosts Git router is installed', async () => {
  // Folder projects and new paths are unrouted, yet their WSL Git may still trust the checkout.
  setLocalGitRuntimeRouter(() => undefined)
  expect(await inspectGitRepoForRegistrationAsync(root)).toMatchObject({
    isRepo: true,
    ownershipError: undefined
  })
  expect(await inspectFolderToGitConversion(root)).toEqual({
    conversion: { updates: { folderUpgradeGitRootPath: root }, rootSpellingMatches: true }
  })
})
