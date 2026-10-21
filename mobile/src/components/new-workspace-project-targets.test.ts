import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../src/shared/execution-host'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'

const LOCAL_HOST_LABEL = getLocalExecutionHostLabel('darwin')

describe('new workspace project targets', () => {
  it('groups local and SSH checkouts of the same project', () => {
    const upstream = { owner: 'stablyai', repo: 'orca' }
    const options = buildNewWorkspaceProjectOptions([
      { id: 'local', displayName: 'orca', path: '/src/orca', upstream },
      {
        id: 'ssh',
        displayName: 'orca',
        path: '/home/dev/orca',
        connectionId: 'build-server',
        upstream
      }
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ label: 'orca', detail: 'stablyai/orca' })
  })

  it('shows the provider slug recovered from canonical git identity', () => {
    const options = buildNewWorkspaceProjectOptions([
      {
        id: 'local',
        displayName: 'orca',
        path: '/src/orca',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/stablyai/orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:stablyai/orca.git'
        }
      }
    ])

    expect(options[0]).toMatchObject({ label: 'orca', detail: 'stablyai/orca' })
  })

  it('labels local, SSH, and paired runtime targets as the host list names them', () => {
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'orca', path: '/src/orca' }, 'darwin')
    ).toEqual({ hostId: 'local', label: LOCAL_HOST_LABEL, detail: '/src/orca' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'orca', path: 'C:\\src\\orca' })
    ).toMatchObject({ label: 'This computer' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'orca', path: 'C:\\src\\orca' }, 'win32')
    ).toMatchObject({ label: 'Local Windows' })
    expect(
      getNewWorkspaceRunTarget({
        id: 'ssh',
        displayName: 'orca',
        path: 'C:\\src\\orca',
        executionHostId: 'ssh:Windows%20VM'
      })
    ).toEqual({ hostId: 'ssh:Windows%20VM', label: 'Windows VM', detail: 'C:\\src\\orca' })
    const server = {
      id: 'runtime',
      displayName: 'orca',
      path: '/src/orca',
      executionHostId: 'runtime:20269ff3-60aa-4e79-a581-513a3f8e394b'
    } as const
    const labels = new Map([[server.executionHostId, 'scratch-server']] as const)
    expect(getNewWorkspaceRunTarget(server, 'darwin', labels)).toEqual({
      hostId: server.executionHostId,
      label: 'scratch-server',
      detail: '/src/orca'
    })
  })

  it('shows one target per host when the project has multiple local worktrees', () => {
    const upstream = { owner: 'stablyai', repo: 'orca' }
    const repos = [
      { id: 'local-a', displayName: 'orca-a', path: '/src/orca-a', upstream },
      { id: 'local-b', displayName: 'orca-b', path: '/src/orca-b', upstream },
      {
        id: 'ssh',
        displayName: 'orca',
        path: '/home/dev/orca',
        connectionId: 'build-server',
        upstream
      }
    ]
    const projectId = buildNewWorkspaceProjectOptions(repos)[0]?.id ?? null

    expect(buildNewWorkspaceRunTargetOptions(repos, projectId, 'darwin')).toEqual([
      expect.objectContaining({ id: 'local', label: LOCAL_HOST_LABEL, detail: '/src/orca-a' }),
      expect.objectContaining({
        id: 'ssh:build-server',
        label: 'build-server',
        detail: '/home/dev/orca'
      })
    ])
  })
})
