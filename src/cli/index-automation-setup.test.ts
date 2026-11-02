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
import {
  buildWorktree,
  okFixture,
  queueFixtures,
  localRepoDestinationFixtures,
  worktreeListFixture
} from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY } from '../shared/protocol-version'

const supported = okFixture('status', {
  capabilities: [AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY]
})
const setupCalls = (): string[] =>
  callMock.mock.calls
    .map(([method]) => String(method))
    .filter((method) => ['status.get', 'automation.create', 'automation.update'].includes(method))

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
        supported,
        ...localRepoDestinationFixtures(),
        okFixture('created', { automation: { id: 'a1', setupDecision: setup } })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await main([...createArgs, '--setup', setup], '/tmp/repo')
      expect(process.exitCode).not.toBe(1)
      expect(setupCalls()).toEqual(['status.get', 'automation.create'])
      expect(callMock).toHaveBeenLastCalledWith(
        'automation.create',
        expect.objectContaining({ setupDecision: setup, workspaceMode: 'new_per_run' })
      )
    }
  )

  it.each([
    [[...createArgs, '--setup', 'run'], 'create'],
    [[...createArgs, '--setup', 'skip'], 'create'],
    [['automations', 'edit', 'a1', '--name', 'Renamed', '--setup', 'run', '--json'], 'edit'],
    [['automations', 'edit', 'a1', '--name', 'Renamed', '--setup', 'skip', '--json'], 'edit']
  ])('refuses %j before any write on a host without the setup contract', async (argv) => {
    queueFixtures(callMock, okFixture('status', { capabilities: [] }))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(argv, '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(setupCalls()).toEqual(['status.get'])
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).error.message).toBe(
      "This host's Orca is too old for --setup on automations. Update Orca on that host, or run the command without --setup."
    )
  })

  it('keeps an omitted create choice on the shipped skip fallback', async () => {
    queueFixtures(
      callMock,
      ...localRepoDestinationFixtures(),
      okFixture('created', { automation: { id: 'a1' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(createArgs, '/tmp/repo')
    expect(setupCalls()).toEqual(['automation.create'])
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
        ...(setup ? [supported] : []),
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
      const update = callMock.mock.calls.find(([method]) => method === 'automation.update')?.[1]
      if (setup) {
        expect(updates.setupDecision).toBe(setup)
        // The choice relies on the stored new-per-run mode, so the host re-checks it at the write.
        expect(update.expectedWorkspaceMode).toBe('new_per_run')
        expect(setupCalls()).toEqual(['status.get', 'automation.update'])
      } else {
        expect(updates).not.toHaveProperty('setupDecision')
        expect(update).not.toHaveProperty('expectedWorkspaceMode')
        expect(setupCalls()).toEqual(['automation.update'])
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
      [...createArgs.slice(0, -1), '--workspace-mode', 'existing'],
      [...createArgs.slice(0, -3), '--workspace', 'id:repo-1::/repo/worktree'],
      ['automations', 'edit', 'a1'],
      ['automations', 'edit', 'a1', '--workspace-mode', 'existing'],
      ['automations', 'edit', 'a1', '--workspace', 'id:repo-1::/repo/worktree']
    ].map((argv) => ({ argv }))
  )('rejects setup on an existing-workspace target: %j', async ({ argv }) => {
    callMock.mockResolvedValue(
      okFixture('read', {
        automation: { id: 'a1', workspaceMode: 'existing' },
        capabilities: [AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY]
      })
    )
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main([...argv, '--setup', 'run', '--json'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(
      callMock.mock.calls.filter(
        ([method]) => method === 'automation.create' || method === 'automation.update'
      )
    ).toHaveLength(0)
    // An explicit target or mode is the cause, so the message carries no current-worktree note.
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).error.message).toBe(
      '--setup only applies to automations that create a new worktree per run, but this one runs in an existing worktree. Pass --workspace-mode new-per-run or omit --setup.'
    )
  })

  it('explains the refusal when create defaults to the current worktree', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')])
    )
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const args = createArgs.filter((arg) => arg !== '--repo' && arg !== 'id:repo-1')
    await main([...args, '--setup', 'run'], '/tmp/repo/feature')
    expect(process.exitCode).toBe(1)
    expect(callMock.mock.calls.map(([method]) => method)).toEqual(['worktree.list'])
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).error.message).toBe(
      '--setup only applies to automations that create a new worktree per run, but this one runs in an existing worktree (with no target, create uses the current worktree). Pass --workspace-mode new-per-run or omit --setup.'
    )
  })

  it('accepts setup while switching an existing automation to new-per-run', async () => {
    queueFixtures(
      callMock,
      supported,
      okFixture('current', { automation: { id: 'a1', workspaceMode: 'existing' } }),
      okFixture('updated', { automation: { id: 'a1', setupDecision: 'run' } })
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
    // An explicit switch is the user's own choice, so it carries no stored-mode precondition.
    expect(callMock.mock.calls.at(-1)?.[1]).not.toHaveProperty('expectedWorkspaceMode')
  })

  it.each(['create', 'edit'])('documents --setup and omission in %s help', async (command) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['automations', command, '--help'], '/tmp/repo')
    const help = output.mock.calls.map(([line]) => String(line)).join('\n')
    expect(help).toContain('--setup run|skip')
    expect(help).toContain(command === 'create' ? 'omitted' : 'preserve')
  })
})
