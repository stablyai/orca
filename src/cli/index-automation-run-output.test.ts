import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../shared/automations-types'

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

const AUTOMATION_ID = '497bafa9-5a97-4f85-9e48-2b211b8f31fa'
const RUN_ID = 'd99b909f-c4a1-4b56-9979-abf57e94be11'

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: RUN_ID,
    automationId: AUTOMATION_ID,
    title: 'Daily checks run 1',
    status: 'dispatching',
    trigger: 'manual',
    scheduledFor: 0,
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0,
    ...overrides
  }
}

function queueRun(result: AutomationRun): void {
  queueFixtures(
    callMock,
    okFixture('req_owner', { automation: { id: AUTOMATION_ID } }),
    okFixture('req_run', { run: result })
  )
}

describe('automation run command output', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  beforeEach(() => {
    vi.stubEnv('ORCA_ENVIRONMENT', undefined)
    vi.stubEnv('ORCA_PAIRING_CODE', undefined)
    vi.stubEnv('ORCA_REMOTE_PAIRING', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prints no acknowledgment until the host returns a delayed result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    queueFixtures(callMock, okFixture('req_owner', { automation: { id: AUTOMATION_ID } }))
    const requested = Promise.withResolvers<void>()
    const response = Promise.withResolvers<ReturnType<typeof okFixture>>()
    callMock.mockImplementationOnce(() => {
      requested.resolve()
      return response.promise
    })
    const command = main(['automations', 'run', AUTOMATION_ID], '/tmp/repo')
    try {
      await requested.promise
      expect(callMock).toHaveBeenCalledTimes(2)
      expect(callMock).toHaveBeenNthCalledWith(2, 'automation.runNow', { id: AUTOMATION_ID })
      expect(log).not.toHaveBeenCalled()
    } finally {
      response.resolve(okFixture('req_run', { run: run({ status: 'dispatched' }) }))
      await command
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0]).split('\n')[0]).toBe(
      `Started run ${RUN_ID} (dispatched).`
    )
  })

  it.each(['explicit', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING'] as const)(
    'requires the same target without exposing %s pairing credentials',
    async (selection) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const pairingCode = 'test-only-pairing-value'
      const flags = selection === 'explicit' ? ['--pairing-code', pairingCode] : []
      if (selection !== 'explicit') {
        process.env[selection] = pairingCode
      }
      queueRun(run())
      await main(['automations', 'run', AUTOMATION_ID, ...flags], '/tmp/repo')
      expect(String(log.mock.calls[0]?.[0]).split('\n').at(-1)).toBe(
        `Follow up on the same host and profile (preserve your connection/profile settings): orca automations runs --id ${AUTOMATION_ID}`
      )
      queueRun(run())
      await main(['automations', 'run', AUTOMATION_ID, ...flags, '--json'], '/tmp/repo')
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual(
        okFixture('req_run', { run: run(), runId: RUN_ID })
      )
      await main(['automations', 'run', ...flags, '--help'], '/tmp/repo')
      expect(log.mock.calls.flat().join('\n')).not.toContain(pairingCode)
    }
  )
})
