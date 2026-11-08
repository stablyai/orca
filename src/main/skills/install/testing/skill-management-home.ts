import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ManagementDependencies } from '../skill-install-preview'

const roots: string[] = []

export async function createSkillManagementHome() {
  let root = ''
  let homeDirectory = ''
  let stateDirectory = ''

  root = await mkdtemp(join(tmpdir(), 'orca-skill-management-test-'))
  homeDirectory = join(root, 'home')
  stateDirectory = join(root, 'state')
  await Promise.all([mkdir(homeDirectory), mkdir(stateDirectory)])

  roots.push(root)
  function dependencies(): ManagementDependencies {
    return {
      authority: {
        environmentId: 'runtime-1',
        homeDirectory,
        resolveWorktree: async () => null,
        resolveFolderWorkspace: async () => null
      },
      stateDirectory,
      detectProviders: async () => ['codex', 'claude']
    }
  }
  return { homeDirectory, dependencies }
}

export async function removeSkillManagementHomes(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}
