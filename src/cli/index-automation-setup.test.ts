import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { okFixture, queueFixtures, localRepoDestinationFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('automation setup CLI contract', () => {
  const originalExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = originalExitCode
  })
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
  const createArgs = [
    'automations',
    'create',
    '--name',
    'Daily checks',
    '--trigger',
    'daily',
    '--prompt',
    'Check changes',
    '--provider',
    'codex',
    '--repo',
    'id:repo-1',
    '--json'
  ]

  it.each(['run', 'skip'])(
    'sends concrete create --setup %s on the existing wire',
    async (setup) => {
      queueFixtures(
        callMock,
        ...localRepoDestinationFixtures(),
        okFixture('created', { automation: { id: 'a1', setupDecision: setup } }),
        okFixture('shown', { automation: { id: 'a1', setupDecision: setup } })
      )
      const output = vi.spyOn(console, 'log').mockImplementation(() => {})
      await main([...createArgs, '--setup', setup], '/tmp/repo')
      expect(process.exitCode).not.toBe(1)
      expect(callMock).toHaveBeenLastCalledWith(
        'automation.create',
        expect.objectContaining({ setupDecision: setup, workspaceMode: 'new_per_run' })
      )
      await main(['automations', 'show', 'a1', '--json'], '/tmp/repo')
      expect(
        JSON.parse(String(output.mock.calls.at(-1)?.[0])).result.automation.setupDecision
      ).toBe(setup)
    }
  )

  it('keeps an omitted create choice on the shipped skip fallback', async () => {
    queueFixtures(
      callMock,
      ...localRepoDestinationFixtures(),
      okFixture('created', { automation: { id: 'a1' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(createArgs, '/tmp/repo')
    expect(callMock).toHaveBeenLastCalledWith(
      'automation.create',
      expect.not.objectContaining({ setupDecision: expect.anything() })
    )
  })

  it.each(['run', 'skip', undefined])(
    'edits with %s and preserves omission and owner fencing',
    async (setup) => {
      const owner = { selector: { kind: 'self' } }
      queueFixtures(
        callMock,
        okFixture('current', {
          automation: { id: 'a1', workspaceMode: 'new_per_run', setupDecision: 'run' },
          owner
        }),
        okFixture('updated', { automation: { id: 'a1', setupDecision: setup ?? 'run' } })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await main(
        [
          'automations',
          'edit',
          'a1',
          '--name',
          'Renamed',
          '--json',
          ...(setup ? ['--setup', setup] : [])
        ],
        '/tmp/repo'
      )
      expect(process.exitCode).not.toBe(1)
      const updates = callMock.mock.calls.find(([method]) => method === 'automation.update')?.[1]
        .updates
      if (setup) {
        expect(updates.setupDecision).toBe(setup)
      } else {
        expect(updates).not.toHaveProperty('setupDecision')
      }
      expect(callMock).toHaveBeenLastCalledWith(
        'automation.update',
        expect.objectContaining({ expectedOwner: owner })
      )
      expect(callMock.mock.calls.filter(([method]) => method === 'automation.show')).toHaveLength(1)
    }
  )

  it.each(['inherit', '', 'true'])(
    'rejects unsupported --setup=%s before a mutation',
    async (setup) => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {})
      await main([...createArgs, `--setup=${setup}`], '/tmp/repo')
      expect(process.exitCode).toBe(1)
      expect(callMock).not.toHaveBeenCalled()
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).error.message).toContain('--setup')
    }
  )

  it.each(
    [
      [
        'automations',
        'create',
        '--name',
        'Daily',
        '--trigger',
        'daily',
        '--prompt',
        'Check',
        '--provider',
        'codex',
        '--repo',
        'id:repo-1',
        '--workspace-mode',
        'existing'
      ],
      ['automations', 'edit', 'a1'],
      ['automations', 'edit', 'a1', '--workspace-mode', 'existing'],
      ['automations', 'edit', 'a1', '--workspace', 'id:repo-1::/repo/worktree']
    ].map((argv) => ({ argv }))
  )('rejects setup on an existing-workspace target: %j', async ({ argv }) => {
    callMock.mockResolvedValue(
      okFixture('read', { automation: { id: 'a1', workspaceMode: 'existing' } })
    )
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main([...argv, '--setup', 'run', '--json'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(
      callMock.mock.calls.filter(
        ([method]) => method === 'automation.create' || method === 'automation.update'
      )
    ).toHaveLength(0)
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).error.message).toContain('new-per-run')
  })

  it('accepts setup while switching an existing automation to new-per-run', async () => {
    queueFixtures(
      callMock,
      okFixture('current', { automation: { id: 'a1', workspaceMode: 'existing' } }),
      okFixture('updated', { automation: { id: 'a1' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['automations', 'edit', 'a1', '--workspace-mode', 'new-per-run', '--setup', 'run', '--json'],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenLastCalledWith(
      'automation.update',
      expect.objectContaining({
        updates: expect.objectContaining({ workspaceMode: 'new_per_run', setupDecision: 'run' })
      })
    )
  })

  it.each(['create', 'edit'])('documents --setup and omission in %s help', async (command) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['automations', command, '--help'], '/tmp/repo')
    const help = output.mock.calls.map(([line]) => String(line)).join('\n')
    expect(help).toContain('--setup run|skip')
    expect(help).toContain(command === 'create' ? 'omitted' : 'preserve')
  })
})
