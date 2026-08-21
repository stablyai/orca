import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveMCodeAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveMCodeAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/mcode-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveMCodeAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('mcode cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveMCodeAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('creates an automation for the enclosing worktree by default', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_automation_create', {
        automation: {
          id: 'auto-1',
          name: 'Daily review',
          prompt: 'Review open changes',
          agentId: 'codex',
          projectId: 'repo-1',
          executionTargetType: 'local',
          executionTargetId: 'local',
          schedulerOwner: 'local_host_service',
          workspaceMode: 'existing',
          workspaceId: 'repo-1::/tmp/repo/feature',
          baseBranch: null,
          timezone: 'America/Toronto',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1,
          enabled: true,
          nextRunAt: 2,
          missedRunPolicy: 'run_once_within_grace',
          missedRunGraceMinutes: 720,
          createdAt: 1,
          updatedAt: 1
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.create', {
      name: 'Daily review',
      prompt: 'Review open changes',
      agentId: 'codex',
      repo: undefined,
      workspace: 'id:repo-1::/tmp/repo/feature',
      workspaceMode: 'existing',
      baseBranch: undefined,
      reuseSession: undefined,
      timezone: undefined,
      enabled: undefined,
      missedRunGraceMinutes: undefined,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: expect.any(Number)
    })
  })

  it('resolves project and host flags for automation create', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-gpu',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'GPU review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'GPU review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--project',
        'github:mcode-ide/mcode',
        '--host',
        'runtime:gpu',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'gpu')
    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'automation.create',
      expect.objectContaining({
        repo: 'id:repo-gpu',
        runContext: {
          kind: 'workspace-run',
          projectId: 'github:mcode-ide/mcode',
          hostId: 'runtime:gpu',
          projectHostSetupId: 'setup-gpu',
          repoId: 'repo-gpu',
          path: '/srv/mcode'
        },
        workspace: undefined,
        workspaceMode: 'new_per_run'
      })
    )
  })

  it('resolves project-host-setup flags for automation edit with explicit run context', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-gpu',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'GPU review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--project-host-setup', 'setup-gpu', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'automation.update',
      expect.objectContaining({
        id: 'auto-1',
        updates: expect.objectContaining({
          repo: 'id:repo-gpu',
          runContext: {
            kind: 'workspace-run',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            projectHostSetupId: 'setup-gpu',
            repoId: 'repo-gpu',
            path: '/srv/mcode'
          }
        })
      })
    )
  })

  it('rejects automation create with both repo and workspace targets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--repo',
        'id:repo-1',
        '--workspace',
        'id:repo-1::/tmp/repo/feature',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --repo or --workspace, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects automation edit with both repo and workspace targets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'edit',
        'auto-1',
        '--repo',
        'id:repo-1',
        '--workspace',
        'id:repo-1::/tmp/repo/feature',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --repo or --workspace, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it.each([
    {
      flag: 'enabled',
      value: 'false',
      message: '--enabled does not take a value'
    },
    {
      flag: 'disabled',
      value: 'false',
      message: '--disabled does not take a value'
    }
  ])('rejects automation create --$flag with a string value', async ({ flag, value, message }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--repo',
        'id:repo-1',
        `--${flag}`,
        value,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(message)
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('resolves explicit automation create workspace active from cwd', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'Daily review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--workspace',
        'active',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.create', {
      name: 'Daily review',
      prompt: 'Review open changes',
      agentId: 'codex',
      repo: undefined,
      workspace: 'id:repo-1::/tmp/repo/feature',
      workspaceMode: 'existing',
      baseBranch: undefined,
      timezone: undefined,
      enabled: undefined,
      missedRunGraceMinutes: undefined,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: expect.any(Number)
    })
  })

  it('resolves explicit automation edit workspace current from cwd', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'Daily review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--workspace', 'current', '--enabled', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.update', {
      id: 'auto-1',
      updates: {
        name: undefined,
        prompt: undefined,
        agentId: undefined,
        repo: undefined,
        workspace: 'id:repo-1::/tmp/repo/feature',
        workspaceMode: undefined,
        baseBranch: undefined,
        reuseSession: undefined,
        timezone: undefined,
        enabled: true,
        missedRunGraceMinutes: undefined
      }
    })
  })
})
