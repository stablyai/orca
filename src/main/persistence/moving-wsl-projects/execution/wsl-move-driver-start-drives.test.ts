/**
 * A start compares only the drives its own planned rows name with what the preview showed: a
 * refused, unanswered, retained or unrelated drive-letter row never refuses a whole-distro start
 * (the orchestrator's Retry sends no ids).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-internal-gate'
import type { WslMoveRequest } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveStartFieldsOf } from '../../../../shared/wsl-move/wsl-move-request'
import type { WslMappedDriveRead } from '../../../wsl/filesystem/wsl-mapped-drive-share'
import { testState } from '../../persistence-test-harness'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  wslMoveRigRetentionStore,
  type WslMoveRig
} from '../../__fixtures__/wsl-mover/wsl-move-kill-rig'
import { listWslMoveCutovers } from '../cutover-recovery/wsl-move-cutover-journal'
import { runWslMoveRetentionPass } from '../cutover-recovery/wsl-move-retention'
import { resetWslMoveDesktopRewriteStoresForTests } from '../desktop-state/wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from '../wsl-move-driver'
import { previewWslMove } from './wsl-move-driver-preview'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

const W = { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }
const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'

let rig: WslMoveRig
let shares: Record<string, WslMappedDriveRead>
let known: Record<string, string | null>

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rig = createWslMoveKillRig()
  shares = { W: { share: W.share } }
  known = { W: W.share }
  rig.world.deps.driveShares = {
    classify: async (letter) => (letter in known ? { share: known[letter] } : null),
    readNow: async (letter) => shares[letter] ?? { share: null }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  removeWslMoveRigDirs()
})

const project = (id: string, path: string) => ({ ...rig.world.repos[0], id, path })

/** Preview, then start as the orchestrator does (no ids) or as the dialog does (the ids shown). */
async function previewThenStart(ids: 'none' | 'shown'): Promise<unknown> {
  const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
  if (preview.outcome !== 'ready') {
    return preview
  }
  const request: WslMoveRequest = {
    distro: 'Ubuntu',
    ...wslMoveStartFieldsOf(preview),
    ...(ids === 'shown'
      ? { repoIds: preview.repoIds, folderWorkspaceIds: preview.folderWorkspaceIds }
      : {})
  }
  return moveProjectsToWslHost(rig.world.deps, request)
}

describe.each(['none', 'shown'] as const)('a whole-distro start with ids %s', (ids) => {
  it('moves a UNC project beside a W: repo the host Git refuses', async () => {
    rig.world.repos = [project('repo-1', UNC), project('repo-w', 'W:\\home\\dev\\other')]
    rig.world.deps.windowsGitVerdict = async () => 'windows-git-worktrees'
    expect(await previewThenStart(ids)).toMatchObject({ outcome: 'moved' })
    expect(listWslMoveCutovers(rig.userDataPath)[0].version).toBe(1)
  })

  it('moves a UNC project beside an unrelated drive that does not answer', async () => {
    rig.world.repos = [project('repo-1', UNC), project('repo-s', 'S:\\shared\\tool')]
    expect(await previewThenStart(ids)).toMatchObject({ outcome: 'moved' })
  })

  it('moves a new UNC project beside a W: project an earlier move took', async () => {
    rig.world.repos = [project('repo-1', 'W:\\home\\dev\\app')]
    expect(await previewThenStart('shown')).toMatchObject({ outcome: 'moved' })
    await runWslMoveRetentionPass({
      userDataPath: rig.userDataPath,
      store: wslMoveRigRetentionStore(rig)
    })
    rig.world.repos = [...rig.world.repos, project('repo-2', `${UNC}2`)]
    // The retained W: row's drive now answers differently; it isn't this start's to compare.
    shares = { W: { share: '\\\\wsl.localhost\\Ubuntu\\home' } }
    expect(await previewThenStart(ids)).toMatchObject({ outcome: 'moved' })
    expect(listWslMoveCutovers(rig.userDataPath).map((record) => record.version)).toContain(1)
  })
})

describe('a whole-distro start whose previewed drive now points elsewhere', () => {
  it('moves the rest and names the projects it left', async () => {
    rig.world.repos = [
      project('repo-1', UNC),
      { ...project('repo-w', 'W:\\home\\dev\\other'), displayName: 'other' }
    ]
    const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
    expect(preview).toMatchObject({ outcome: 'ready', repoIds: ['repo-1', 'repo-w'] })
    shares = { W: { share: '\\\\wsl.localhost\\Debian' } }
    expect(
      await moveProjectsToWslHost(rig.world.deps, {
        distro: 'Ubuntu',
        ...wslMoveStartFieldsOf(preview)
      })
    ).toMatchObject({
      outcome: 'moved',
      droppedForMappedDrives: [{ kind: 'repo', id: 'repo-w', name: 'other' }]
    })
  })
})

describe('a repo the Git-for-Windows check refuses', () => {
  beforeEach(() => {
    rig.world.repos = [project('repo-1', UNC), project('repo-w', 'W:\\home\\dev\\other')]
    rig.world.deps.windowsGitVerdict = async (path) =>
      path.endsWith('other') ? 'windows-git-worktrees' : 'ok'
  })

  it('shows Git’s reason even while its drive does not answer', async () => {
    shares = { W: 'unverifiable' }
    const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
    expect(preview.outcome === 'ready' ? preview.refused : null).toEqual([
      { kind: 'repo', id: 'repo-w', reason: 'windows-git-worktrees' }
    ])
  })

  it('is not named as left behind when its drive points elsewhere at start', async () => {
    rig.world.repos.push({
      ...project('repo-w2', 'W:\\home\\dev\\movable'),
      displayName: 'movable'
    })
    const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
    expect(preview).toMatchObject({ outcome: 'ready', mappedDrives: [W] })
    shares = { W: { share: '\\\\wsl.localhost\\Debian' } }
    const result = await moveProjectsToWslHost(rig.world.deps, {
      distro: 'Ubuntu',
      ...wslMoveStartFieldsOf(preview)
    })
    expect(result).toMatchObject({
      outcome: 'moved',
      droppedForMappedDrives: [{ kind: 'repo', id: 'repo-w2', name: 'movable' }]
    })
  })

  it('is named as left behind when the preview showed it moving and Git refuses it only at start', async () => {
    rig.world.deps.windowsGitVerdict = async () => 'ok'
    const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
    expect(preview).toMatchObject({ outcome: 'ready', repoIds: ['repo-1', 'repo-w'], refused: [] })
    // W: is remapped and Git for Windows adds a worktree to repo-w before the start.
    shares = { W: { share: '\\\\wsl.localhost\\Debian' } }
    rig.world.deps.windowsGitVerdict = async (path) =>
      path.endsWith('other') ? 'windows-git-worktrees' : 'ok'
    const result = await moveProjectsToWslHost(rig.world.deps, {
      distro: 'Ubuntu',
      ...wslMoveStartFieldsOf(preview)
    })
    expect(result).toMatchObject({
      outcome: 'moved',
      droppedForMappedDrives: [{ kind: 'repo', id: 'repo-w' }]
    })
  })
})

describe('the projects a start names as left behind', () => {
  it('leaves out a repo the preview refused for another reason', async () => {
    rig.world.repos = [
      project('repo-1', UNC),
      { ...project('repo-w', 'W:\\home\\dev\\other'), displayName: 'other' },
      { ...project('repo-mixed', 'W:\\home\\dev\\mixed'), worktreeBasePath: 'C:\\trees' }
    ]
    const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
    expect(preview).toMatchObject({
      outcome: 'ready',
      repoIds: ['repo-1', 'repo-w'],
      refused: [{ kind: 'repo', id: 'repo-mixed', reason: 'mixed-locations' }]
    })
    shares = { W: { share: '\\\\wsl.localhost\\Debian' } }
    const result = await moveProjectsToWslHost(rig.world.deps, {
      distro: 'Ubuntu',
      ...wslMoveStartFieldsOf(preview)
    })
    expect(result).toMatchObject({
      outcome: 'moved',
      droppedForMappedDrives: [{ kind: 'repo', id: 'repo-w', name: 'other' }]
    })
    expect(result.outcome === 'moved' ? result.droppedForMappedDrives : null).toHaveLength(1)
  })

  it('leaves out a repo the start did not pick', async () => {
    rig.world.repos = [project('repo-1', UNC), project('repo-w', 'W:\\home\\dev\\other')]
    const preview = await previewWslMove(rig.world.deps, { distro: 'Ubuntu' })
    expect(preview).toMatchObject({ outcome: 'ready', repoIds: ['repo-1', 'repo-w'] })
    shares = { W: { share: '\\\\wsl.localhost\\Debian' } }
    const result = await moveProjectsToWslHost(rig.world.deps, {
      distro: 'Ubuntu',
      repoIds: ['repo-1'],
      folderWorkspaceIds: [],
      ...wslMoveStartFieldsOf(preview)
    })
    expect(result).toMatchObject({ outcome: 'moved' })
    expect(result).not.toHaveProperty('droppedForMappedDrives')
  })
})
