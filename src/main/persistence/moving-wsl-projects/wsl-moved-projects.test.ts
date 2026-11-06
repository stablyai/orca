import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import { listWslMovedProjects } from './wsl-moved-projects'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev'
const repos = [
  { id: 'repo-1', displayName: 'Repo one', path: `${UNC}\\repo-1` },
  // The host's own row after the move: same id, another host.
  {
    id: 'repo-1',
    displayName: 'Repo one',
    path: '/home/dev/repo-1',
    executionHostId: 'runtime:wsl-ubuntu' as const
  },
  { id: 'repo-2', displayName: 'Staying', path: '/src/repo-2' }
]
const folders = [{ id: 'notes', name: 'Notes', folderPath: `${UNC}\\notes` }]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsl-moved-projects-'))
  loadWslMoveFence(dir)
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(dir, { recursive: true, force: true })
})

const record = (phase: Parameters<typeof cutover>[1]) =>
  cutover('move-1', phase, {}, { repoIds: ['repo-1'], folderWorkspaceIds: ['notes'] })

describe('listWslMovedProjects', () => {
  it('lists nothing while a move is only taking the projects', () => {
    seedWslMoveCutover(dir, record('blobs-transferred'))
    expect(listWslMovedProjects(repos, folders)).toEqual([])
  })

  it("lists only this machine's rows the host owns, with the host's distro", () => {
    seedWslMoveCutover(dir, record('destination-committed'))
    expect(listWslMovedProjects(repos, folders)).toEqual([
      {
        kind: 'repo',
        id: 'repo-1',
        displayName: 'Repo one',
        path: repos[0].path,
        distro: 'Ubuntu'
      },
      {
        kind: 'folder',
        id: 'notes',
        displayName: 'Notes',
        path: folders[0].folderPath,
        distro: 'Ubuntu'
      }
    ])
  })

  it('never lists an SSH row that shares a moved id', () => {
    seedWslMoveCutover(dir, record('retained'))
    const ssh = [{ id: 'repo-1', displayName: 'Remote', path: '/r', connectionId: 'target-1' }]
    expect(listWslMovedProjects(ssh, [])).toEqual([])
  })
})
