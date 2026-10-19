import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import { PiRpcSessionAdapter } from './rpc-session-adapter'

vi.mock('../windows/windows-process-table', () => ({ isWindowsProcessStartTimeAvailable: vi.fn() }))

const originalPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.resetAllMocks()
})

const local: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
}

describe('Pi execution host support', () => {
  it.each([false, true])(
    'requires Windows process identity proof at both support seams (%s)',
    (proof) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.mocked(isWindowsProcessStartTimeAvailable).mockReturnValue(proof)
      const adapter = new PiRpcSessionAdapter({
        resolveLaunch: async () => {
          throw new Error('A location check must not acquire a process')
        },
        onLifecycle: vi.fn(),
        onSettled: vi.fn(),
        onIdle: vi.fn(),
        logger: { warn: vi.fn(), error: vi.fn() }
      })
      expect(structuredAgentRuntimeRegistration('pi')?.supportsLocation(local)).toBe(proof)
      expect(adapter.supportsCreate(local, 'pi')).toBe(proof)
    }
  )

  it('refuses another execution host and WSL without probing local process identity', () => {
    const registration = structuredAgentRuntimeRegistration('pi')
    expect(registration?.supportsLocation({ ...local, executionHostId: 'runtime:remote' })).toBe(
      false
    )
    expect(registration?.supportsLocation({ ...local, wslDistro: 'Ubuntu' })).toBe(false)
    expect(isWindowsProcessStartTimeAvailable).not.toHaveBeenCalled()
  })
})
