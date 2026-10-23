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
import { okFixture, queueFixtures } from './test-fixtures'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli automation extra agent args', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sends the exact text after confirming the runtime applies it', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', { capabilities: [AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY] }),
      okFixture('req_edit_owner', { automation: { id: 'auto-1', name: 'Daily review' } }),
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Daily review' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'edit',
        'auto-1',
        '--extra-agent-args=--model opus --add-dir "a b"',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(3, 'automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ extraAgentArgs: '--model opus --add-dir "a b"' })
    })
  })

  it('clears with an explicit empty value without a capability probe', async () => {
    queueFixtures(
      callMock,
      okFixture('req_edit_owner', { automation: { id: 'auto-1', name: 'Daily review' } }),
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Daily review' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--extra-agent-args=', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ extraAgentArgs: '' })
    })
  })

  it('refuses nonempty extras on a runtime that would drop them', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['automations', 'edit', 'auto-1', '--extra-agent-args=--model opus', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Update Orca on this host to use extra arguments.'
    )
    process.exitCode = priorExitCode
  })
})
