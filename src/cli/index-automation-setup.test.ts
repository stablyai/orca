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
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY } from '../shared/automations/automation-runtime-capabilities'

const supported = okFixture('status', {
  capabilities: [AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY]
})

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
})
