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
    const upstream = { owner: 'stablyai', repo: 'mcode' }
    const options = buildNewWorkspaceProjectOptions([
      { id: 'local', displayName: 'mcode', path: '/src/mcode', upstream },
      {
        id: 'ssh',
        displayName: 'mcode',
        path: '/home/dev/mcode',
        connectionId: 'build-server',
        upstream
      }
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ label: 'mcode', detail: 'mcode-ide/mcode' })
  })

  it('shows the provider slug recovered from canonical git identity', () => {
    const options = buildNewWorkspaceProjectOptions([
      {
        id: 'local',
        displayName: 'mcode',
        path: '/src/mcode',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/mcode-ide/mcode',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:mcode-ide/mcode.git'
        }
      }
    ])

    expect(options[0]).toMatchObject({ label: 'mcode', detail: 'mcode-ide/mcode' })
  })

  it('labels local, SSH, and paired runtime targets', () => {
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'mcode', path: '/src/mcode' }, 'darwin')
    ).toEqual({ label: LOCAL_HOST_LABEL, detail: '/src/mcode' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'mcode', path: 'C:\\src\\mcode' })
    ).toEqual({ label: 'This computer', detail: 'C:\\src\\mcode' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'mcode', path: 'C:\\src\\mcode' }, 'win32')
    ).toEqual({ label: 'Local Windows', detail: 'C:\\src\\mcode' })
    expect(
      getNewWorkspaceRunTarget({
        id: 'ssh',
        displayName: 'mcode',
        path: 'C:\\src\\mcode',
        executionHostId: 'ssh:Windows%20VM'
      })
    ).toEqual({ label: 'SSH · Windows VM', detail: 'C:\\src\\mcode' })
    expect(
      getNewWorkspaceRunTarget({
        id: 'runtime',
        displayName: 'mcode',
        path: '/src/mcode',
        executionHostId: 'runtime:devbox'
      })
    ).toEqual({ label: 'Remote · devbox', detail: '/src/mcode' })
  })

  it('shows one target per host when the project has multiple local worktrees', () => {
    const upstream = { owner: 'stablyai', repo: 'mcode' }
    const repos = [
      { id: 'local-a', displayName: 'mcode-a', path: '/src/mcode-a', upstream },
      { id: 'local-b', displayName: 'mcode-b', path: '/src/mcode-b', upstream },
      {
        id: 'ssh',
        displayName: 'mcode',
        path: '/home/dev/mcode',
        connectionId: 'build-server',
        upstream
      }
    ]
    const projectId = buildNewWorkspaceProjectOptions(repos)[0]?.id ?? null

    expect(buildNewWorkspaceRunTargetOptions(repos, projectId, 'darwin')).toEqual([
      expect.objectContaining({ id: 'local-a', label: LOCAL_HOST_LABEL, detail: '/src/mcode-a' }),
      expect.objectContaining({ id: 'ssh', label: 'SSH · build-server', detail: '/home/dev/mcode' })
    ])
  })
})
