import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import { getNextProjectGroupOrder } from '../../../shared/project/groups/project-groups'
import { ProjectGroupPersistenceOperations } from '../../persistence/tracking-repos/project-group-operations'
import { partialRuntimeStore } from '../construction/test-context/runtime-store-partial-fixture'
import { RuntimeNestedRepoImport } from './runtime-nested-repo-import'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function initGitRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: path })
  return path
}

function createParentFolder(): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'orca-nested-import-')))
  tempDirs.push(parent)
  return parent
}

function createImporter(state: PersistedState): RuntimeNestedRepoImport {
  const groups = new ProjectGroupPersistenceOperations({
    state,
    scheduleSave: () => {},
    removeWorkspaceLineageForRemovedFolder: () => {},
    pruneMobileClientTabSelections: () => {}
  })
  const store = partialRuntimeStore({
    getRepos: () => [...state.repos],
    addRepo: (repo) => void state.repos.push(repo),
    getProjectGroups: () => groups.getProjectGroups(),
    createProjectGroup: (input) => groups.createProjectGroup(input),
    updateProjectGroup: (groupId, updates) => groups.updateProjectGroup(groupId, updates),
    setProjectGroupParents: (moves) => groups.setProjectGroupParents(moves),
    deleteProjectGroup: (groupId) => groups.deleteProjectGroup(groupId),
    moveProjectToGroup: (target, groupId, order) => {
      const repo = state.repos.find((entry) => entry.id === target.id) ?? null
      if (repo) {
        const siblings = state.repos.filter((entry) => entry !== repo)
        repo.projectGroupId = groupId
        repo.projectGroupOrder = order ?? getNextProjectGroupOrder(siblings, groupId)
      }
      return repo
    }
  })
  return new RuntimeNestedRepoImport({
    getStore: () => store,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
}

describe('RuntimeNestedRepoImport', () => {
  it('keeps member order in a reused folder-scan group and appends new repos', async () => {
    const parent = createParentFolder()
    const repoA = initGitRepo(join(parent, 'a'))
    const repoB = initGitRepo(join(parent, 'b'))
    const state = getDefaultPersistedState(parent)
    const importer = createImporter(state)
    const importArgs = { parentPath: parent, groupName: 'PARENT', mode: 'group' as const }

    const first = await importer.import({ ...importArgs, projectPaths: [repoA, repoB] })
    const [a, b] = state.repos
    a.projectGroupOrder = 1500
    b.projectGroupOrder = 500
    const repoC = initGitRepo(join(parent, 'c'))
    const second = await importer.import({ ...importArgs, projectPaths: [repoA, repoB, repoC] })

    expect(second.group?.id).toBe(first.group?.id)
    expect(state.repos.map((repo) => [repo.projectGroupId, repo.projectGroupOrder])).toEqual([
      [first.group?.id, 1500],
      [first.group?.id, 500],
      [first.group?.id, 1501]
    ])
  })

  it('re-parents a reused subgroup when a new folder scope appears above it', async () => {
    const parent = createParentFolder()
    const sharedRepos = [
      initGitRepo(join(parent, 'pkgs', 'shared', 'one')),
      initGitRepo(join(parent, 'pkgs', 'shared', 'two'))
    ]
    const state = getDefaultPersistedState(parent)
    const importer = createImporter(state)
    const folderName = basename(parent)
    const importArgs = { parentPath: parent, groupName: folderName, mode: 'group' as const }

    await importer.import({ ...importArgs, projectPaths: sharedRepos })
    const sharedGroupId = state.repos[0]?.projectGroupId
    const pkgsRepo = initGitRepo(join(parent, 'pkgs', 'tool'))
    await importer.import({ ...importArgs, projectPaths: [...sharedRepos, pkgsRepo] })

    const groupsByName = new Map(state.projectGroups?.map((group) => [group.name, group]))
    expect([...groupsByName.keys()].sort()).toEqual([folderName, 'pkgs', 'pkgs/shared'].sort())
    expect(groupsByName.get('pkgs/shared')?.id).toBe(sharedGroupId)
    expect(groupsByName.get('pkgs/shared')?.parentGroupId).toBe(groupsByName.get('pkgs')?.id)
    expect(state.repos.map((repo) => repo.projectGroupId)).toEqual([
      sharedGroupId,
      sharedGroupId,
      groupsByName.get('pkgs')?.id
    ])
  })

  it('renames a reused group only when the entered name was edited', async () => {
    const parent = createParentFolder()
    const repoA = initGitRepo(join(parent, 'a'))
    const folderName = basename(parent)
    const state = getDefaultPersistedState(parent)
    const importer = createImporter(state)
    const importArgs = { parentPath: parent, projectPaths: [repoA], mode: 'group' as const }

    const importNamed = async (groupName: string) => {
      const { group } = await importer.import({ ...importArgs, groupName })
      return { id: group?.id, name: group?.name }
    }

    const first = await importNamed('Mine')
    expect(first).toEqual({ id: expect.any(String), name: 'Mine' })
    expect(await importNamed(folderName)).toEqual(first)
    expect(await importNamed(' Edited ')).toEqual({ ...first, name: 'Edited' })
    expect(state.projectGroups).toHaveLength(1)
  })
})
