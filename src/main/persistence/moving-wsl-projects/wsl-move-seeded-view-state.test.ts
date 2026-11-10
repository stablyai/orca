import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session/workspace-session-state-types'
import { withWslMoveSeededViewState } from './wsl-move-seeded-view-state'

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const UNC = `repo-a::${UNC_ROOT}`
const HOST = 'repo-a::/home/dev/app'
const scope = {
  destinationEnvironmentId: 'wsl:Ubuntu',
  inScope: (owner: string) => owner.startsWith('repo-a::'),
  worktreeId: (id: string) => (id === UNC ? HOST : id),
  path: (value: string) => value.replace('\\\\wsl.localhost\\Ubuntu', '').replaceAll('\\', '/')
}

const file = (filePath: string, worktreeId: string, draft?: string): PersistedOpenFile => ({
  filePath,
  relativePath: 'README.md',
  worktreeId,
  language: 'markdown',
  ...(draft === undefined ? {} : { dirtyDraftContent: draft, lastKnownDiskSignature: 'sig-1' })
})

const seed = (): WorkspaceSessionState => ({
  ...getDefaultWorkspaceSession(),
  openFilesByWorktree: { [HOST]: [file('/home/dev/app/README.md', HOST)] }
})
const local = {
  openFilesByWorktree: { [UNC]: [file(`${UNC_ROOT}\\README.md`, UNC, '# unsaved')] }
}

describe('withWslMoveSeededViewState', () => {
  it("lays this desktop's draft and its disk baseline over the seeded file, owned by the host", () => {
    const next = withWslMoveSeededViewState(seed(), local, scope, new Set([HOST]))

    // Without the host as owner the draft opens as this desktop's file, and the mirror drops it.
    expect(next?.openFilesByWorktree?.[HOST]).toEqual([
      { ...file('/home/dev/app/README.md', HOST, '# unsaved'), runtimeEnvironmentId: 'wsl:Ubuntu' }
    ])
  })

  it('never replaces a draft the seeded record already has', () => {
    const drafted = seed()
    drafted.openFilesByWorktree = { [HOST]: [file('/home/dev/app/README.md', HOST, '# newer')] }
    expect(withWslMoveSeededViewState(drafted, local, scope, new Set([HOST]))).toBeNull()
  })
})
