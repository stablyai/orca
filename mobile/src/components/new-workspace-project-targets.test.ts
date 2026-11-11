import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../src/shared/execution-host'
import {
  buildNewWorkspaceGrouping,
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'

const LOCAL_HOST_LABEL = getLocalExecutionHostLabel('darwin')

describe('new workspace project targets', () => {
  it('keeps the actual old-desktop split rule and names each served folder choice by host and path', () => {
    const a = {
      id: 'a',
      displayName: 'app',
      path: '/repos/a',
      upstream: { owner: 'org', repo: 'app' }
    }
    const repos = [
      a,
      { ...a, id: 'b', path: '/repos/b' },
      { ...a, id: 'c', executionHostId: 'runtime:server' as const }
    ]
    const legacy = buildNewWorkspaceGrouping(repos, null)
    expect(legacy.groups).toHaveLength(3)
    const options = buildNewWorkspaceProjectOptions(
      repos,
      { projectGroupingMode: 'folder' },
      undefined,
      'darwin',
      new Map([['runtime:server', 'Build box']])
    )
    expect(options.map((option) => option.detail)).toEqual([
      `${LOCAL_HOST_LABEL} · /repos/a`,
      `${LOCAL_HOST_LABEL} · /repos/b`,
      'Build box · /repos/a'
    ])
    for (const option of options) {
      expect(
        buildNewWorkspaceRunTargetOptions(repos, option.id, null, undefined, {
          projectGroupingMode: 'folder'
        }).map((target) => target.repo)
      ).toEqual([option.repo])
    }
  })

  it('keeps physical aliases in the same project and preserves concrete run-target choices', () => {
    const pending = { id: 'pending', path: '/repos/app', displayName: 'app' }
    const identified = {
      ...pending,
      id: 'identified',
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/org/app',
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/org/app.git'
      }
    }
    const repos = [
      pending,
      identified,
      { ...identified, id: 'second', path: '/repos/second' },
      { ...identified, executionHostId: 'runtime:server' as const }
    ]
    for (const [mode, count] of [
      ['repository', 1],
      ['host', 2],
      ['folder', 3]
    ] as const) {
      const settings = { projectGroupingMode: mode }
      const options = buildNewWorkspaceProjectOptions(repos, settings)
      expect(options).toHaveLength(count)
      const aliasGroup = options.find((option) => option.repo.id === 'pending')
      const targets = buildNewWorkspaceRunTargetOptions(
        repos,
        aliasGroup?.id ?? null,
        null,
        undefined,
        settings
      )
      expect(targets.map((target) => target.id)).toContain('local::pending')
      expect(targets.map((target) => target.id)).toContain('local::identified')
      expect(targets.some((target) => target.repo.id === 'second')).toBe(mode !== 'folder')
      expect(targets.some((target) => target.hostId === 'runtime:server')).toBe(
        mode === 'repository'
      )
    }
  })

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

  it('keeps every checkout selectable when a host has multiple folders', () => {
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
    const projectId =
      buildNewWorkspaceProjectOptions(repos, { projectGroupingMode: 'repository' })[0]?.id ?? null

    expect(
      buildNewWorkspaceRunTargetOptions(repos, projectId, 'darwin', undefined, {
        projectGroupingMode: 'repository'
      })
    ).toEqual([
      expect.objectContaining({
        id: 'local::local-a',
        label: LOCAL_HOST_LABEL,
        detail: '/src/orca-a'
      }),
      expect.objectContaining({
        id: 'local::local-b',
        label: LOCAL_HOST_LABEL,
        detail: '/src/orca-b'
      }),
      expect.objectContaining({
        id: 'ssh:build-server::ssh',
        label: 'build-server',
        detail: '/home/dev/orca'
      })
    ])
  })
})
