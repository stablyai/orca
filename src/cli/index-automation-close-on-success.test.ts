import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
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
import {
  buildWorktree,
  localRepoDestinationFixtures,
  okFixture,
  queueFixtures,
  workspaceDestinationFixtures,
  worktreeListFixture
} from './test-fixtures'
import { AUTOMATION_CLOSE_ON_SUCCESS_CAPABILITY } from '../shared/automation-runtime-capabilities'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

const CREATE = [
  'automations',
  'create',
  '--name',
  'Daily review',
  '--trigger',
  'daily',
  '--prompt',
  'Review changes',
  '--provider',
  'codex'
]
const SUPPORTED = { capabilities: [AUTOMATION_CLOSE_ON_SUCCESS_CAPABILITY] }
const AUTOMATION = { id: 'auto-1', reuseSession: false, closeOnSuccess: false }

describe('orca cli automation close on success', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    ['--close-on-success', true],
    ['--no-close-on-success', false]
  ])('creates an existing-workspace automation with %s', async (flag, value) => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('status', SUPPORTED),
      ...workspaceDestinationFixtures(),
      okFixture('create', { automation: { ...AUTOMATION, closeOnSuccess: value } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([...CREATE, '--workspace', 'current', String(flag), '--json'], '/tmp/repo/feature')

    expect(callMock).toHaveBeenNthCalledWith(2, 'status.get')
    expect(callMock).toHaveBeenLastCalledWith(
      'automation.create',
      expect.objectContaining({
        workspace: 'id:repo-1::/tmp/repo/feature',
        workspaceMode: 'existing',
        closeOnSuccess: value
      })
    )
  })

  it.each([
    ['--close-on-success', true],
    ['--no-close-on-success', false]
  ])('edits with %s on the selected remote host', async (flag, value) => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('status', SUPPORTED),
      okFixture('show', { automation: AUTOMATION }),
      okFixture('update', { automation: { ...AUTOMATION, closeOnSuccess: value } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', String(flag), 'auto-1', '--environment', 'gpu', '--json'],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenLastCalledWith(undefined, 'gpu')
    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenLastCalledWith('automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ closeOnSuccess: value })
    })
  })

  it('omits the field on create when no close option is requested', async () => {
    queueFixtures(
      callMock,
      ...localRepoDestinationFixtures(),
      okFixture('create', { automation: AUTOMATION })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([...CREATE, '--repo', 'id:repo-1', '--json'], '/tmp/repo')

    expect(callMock.mock.calls.map(([method]) => method)).toEqual([
      'repo.show',
      'automation.create'
    ])
    expect(callMock.mock.calls[1]?.[1]).not.toHaveProperty('closeOnSuccess')
  })

  it.each(['list', 'show'])('preserves the saved value in %s JSON', async (command) => {
    const saved = { ...AUTOMATION, closeOnSuccess: true }
    queueFixtures(
      callMock,
      okFixture('read', command === 'list' ? { automations: [saved] } : { automation: saved })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', command, ...(command === 'show' ? ['auto-1'] : []), '--json'],
      '/tmp/repo'
    )

    const output = JSON.parse(log.mock.calls.flat().join(''))
    expect(
      command === 'list'
        ? output.result.automations[0].closeOnSuccess
        : output.result.automation.closeOnSuccess
    ).toBe(true)
  })

  it('rejects an explicit reuse conflict on create before mutation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [...CREATE, '--repo', 'id:repo-1', '--reuse-session', '--close-on-success', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join('')).toContain('--fresh-session')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('allows disabling closing while enabling reuse', async () => {
    queueFixtures(
      callMock,
      okFixture('status', SUPPORTED),
      okFixture('show', {
        automation: { ...AUTOMATION, closeOnSuccess: true }
      }),
      okFixture('update', { automation: { ...AUTOMATION, reuseSession: true } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--reuse-session', '--no-close-on-success', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenLastCalledWith('automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ reuseSession: true, closeOnSuccess: false })
    })
  })

  it('omits the field and capability probe when editing another property', async () => {
    queueFixtures(
      callMock,
      okFixture('show', { automation: { ...AUTOMATION, closeOnSuccess: true } }),
      okFixture('update', { automation: { ...AUTOMATION, closeOnSuccess: true } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--name', 'Renamed', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock.mock.calls[1]?.[1].updates).not.toHaveProperty('closeOnSuccess')
    expect(callMock.mock.calls[1]?.[1].updates.name).toBe('Renamed')
  })

  it('creates on a selected project runtime after checking that host', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('setups', {
        setups: [
          {
            id: 'setup-gpu',
            projectId: 'project-1',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/project',
            displayName: 'Project',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('status', SUPPORTED),
      ...localRepoDestinationFixtures('repo-gpu'),
      okFixture('create', { automation: { ...AUTOMATION, closeOnSuccess: true } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        ...CREATE,
        '--project',
        'project-1',
        '--host',
        'runtime:gpu',
        '--close-on-success',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenLastCalledWith(null, 'gpu')
    expect(callMock).toHaveBeenNthCalledWith(2, 'status.get')
    expect(callMock).toHaveBeenLastCalledWith(
      'automation.create',
      expect.objectContaining({
        closeOnSuccess: true,
        repo: 'id:repo-gpu',
        runContext: expect.objectContaining({ hostId: 'runtime:gpu' })
      })
    )
  })

  it.each(['create', 'edit'])(
    'rejects contradictory flags on %s without mutation',
    async (command) => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const priorExitCode = process.exitCode
      const args =
        command === 'create'
          ? [...CREATE, '--repo', 'id:repo-1']
          : ['automations', 'edit', 'auto-1']

      await main([...args, '--close-on-success', '--no-close-on-success', '--json'], '/tmp/repo')

      expect(callMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      process.exitCode = priorExitCode
    }
  )

  it.each(['--close-on-success', '--no-close-on-success'])(
    'rejects a value for %s',
    async (flag) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const priorExitCode = process.exitCode

      await main(['automations', 'edit', 'auto-1', `${flag}=false`, '--json'], '/tmp/repo')

      expect(callMock).not.toHaveBeenCalled()
      expect(log.mock.calls.flat().join('')).toContain(`${flag} does not take a value`)
      expect(process.exitCode).toBe(1)
      process.exitCode = priorExitCode
    }
  )

  it.each([
    ['create', '--close-on-success'],
    ['create', '--no-close-on-success'],
    ['edit', '--close-on-success'],
    ['edit', '--no-close-on-success']
  ])('rejects %s %s on an older host before mutation', async (command, flag) => {
    queueFixtures(callMock, okFixture('status', {}))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const args =
      command === 'create' ? [...CREATE, '--repo', 'id:repo-1'] : ['automations', 'edit', 'auto-1']

    await main([...args, flag, '--json'], '/tmp/repo')

    expect(callMock.mock.calls).toEqual([['status.get']])
    expect(log.mock.calls.flat().join('')).toContain('incompatible_runtime')
    expect(log.mock.calls.flat().join('')).toContain('Update Orca on this host')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('rejects an effective conflict with saved reuse and explains fresh sessions', async () => {
    queueFixtures(
      callMock,
      okFixture('status', SUPPORTED),
      okFixture('show', {
        automation: { ...AUTOMATION, reuseSession: true }
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['automations', 'edit', 'auto-1', '--close-on-success', '--json'], '/tmp/repo')

    expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get', 'automation.show'])
    expect(log.mock.calls.flat().join('')).toContain('--fresh-session')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('allows enabling while explicitly disabling saved reuse', async () => {
    queueFixtures(
      callMock,
      okFixture('status', SUPPORTED),
      okFixture('show', {
        automation: { ...AUTOMATION, reuseSession: true }
      }),
      okFixture('update', { automation: { ...AUTOMATION, closeOnSuccess: true } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--fresh-session', '--close-on-success', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenLastCalledWith('automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ reuseSession: false, closeOnSuccess: true })
    })
  })

  it('rejects enabling reuse when closing is already saved', async () => {
    queueFixtures(
      callMock,
      okFixture('show', { automation: { ...AUTOMATION, closeOnSuccess: true } })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['automations', 'edit', 'auto-1', '--reuse-session', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.flat().join('')).toContain('--fresh-session')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
