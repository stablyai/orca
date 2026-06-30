import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/types'

const {
  applyAgentStatusHooksEnabledMock,
  callMock,
  getCliStatusMock,
  getDefaultUserDataPathMock,
  getManagedAgentHookStatusesMock
} = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn(),
  callMock: vi.fn(),
  getCliStatusMock: vi.fn(() =>
    Promise.resolve({
      id: 'test-status',
      ok: true,
      result: {
        app: { running: false, pid: null },
        runtime: { state: 'not_running', reachable: false, runtimeId: null },
        graph: { state: 'not_running' }
      },
      _meta: { runtimeId: 'test' }
    })
  ),
  getDefaultUserDataPathMock: vi.fn(),
  getManagedAgentHookStatusesMock: vi.fn()
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends Error {
    readonly response: unknown

    constructor(response: unknown) {
      super('rpc failure')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    getDefaultUserDataPath: getDefaultUserDataPathMock
  }
})

vi.mock('../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock
}))

import { main } from '../index'

function readDataFile(userDataPath: string): PersistedState {
  return JSON.parse(readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')) as PersistedState
}

function writeDataFile(userDataPath: string, state: PersistedState): void {
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(join(userDataPath, 'orca-data.json'), JSON.stringify(state, null, 2), 'utf-8')
}

async function runAgentHooksOff(userDataPath: string): Promise<void> {
  getDefaultUserDataPathMock.mockReturnValue(userDataPath)
  await main(['agent', 'hooks', 'off', '--json'], userDataPath)
}

describe('agent hooks CLI handler', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-cli-'))
    applyAgentStatusHooksEnabledMock.mockReturnValue([])
    callMock.mockReset()
    getCliStatusMock.mockClear()
    getManagedAgentHookStatusesMock.mockReturnValue([])
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps the fresh-profile new card style default when creating offline settings', async () => {
    await runAgentHooksOff(userDataPath)

    const persisted = readDataFile(userDataPath)

    expect(persisted.settings.experimentalNewWorktreeCardStyle).toBe(true)
    expect(persisted.settings.agentStatusHooksEnabled).toBe(false)
  })

  it('defaults missing new card style on while offline-updated onboarding is open', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    delete existing.settings.experimentalNewWorktreeCardStyle
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDataFile(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(true)
  })

  it('preserves an existing explicit new card style opt-out when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    existing.settings.experimentalNewWorktreeCardStyle = false
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDataFile(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(false)
  })
})

describe('agent label CLI handler', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-label-cli-'))
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('calls agent.label.set with the explicit terminal handle and label', async () => {
    callMock.mockResolvedValue({
      id: 'set',
      ok: true,
      result: { label: { terminalHandle: 'term_abc', paneKey: 'tab-1:leaf', label: 'Reset AI' } },
      _meta: { runtimeId: 'test' }
    })

    await main(
      ['agent', 'label', 'set', '--terminal', 'term_abc', '--label', 'Reset AI', '--json'],
      userDataPath
    )

    expect(callMock).toHaveBeenCalledWith('agent.label.set', {
      terminal: 'term_abc',
      label: 'Reset AI'
    })
  })

  it('calls agent.label.clear with the explicit terminal handle', async () => {
    callMock.mockResolvedValue({
      id: 'clear',
      ok: true,
      result: { label: { terminalHandle: 'term_abc', paneKey: 'tab-1:leaf', label: null } },
      _meta: { runtimeId: 'test' }
    })

    await main(['agent', 'label', 'clear', '--terminal', 'term_abc'], userDataPath)

    expect(callMock).toHaveBeenCalledWith('agent.label.clear', { terminal: 'term_abc' })
  })

  it('echoes the resolved pane and handle in human output so a mis-target is visible', async () => {
    const logSpy = vi.spyOn(console, 'log')
    callMock.mockResolvedValue({
      id: 'set',
      ok: true,
      result: { label: { terminalHandle: 'term_abc', paneKey: 'tab-1:leaf', label: 'Reset AI' } },
      _meta: { runtimeId: 'test' }
    })

    await main(
      ['agent', 'label', 'set', '--terminal', 'term_abc', '--label', 'Reset AI'],
      userDataPath
    )

    const output = logSpy.mock.calls.map((args) => String(args[0])).join('\n')
    expect(output).toContain('term_abc')
    expect(output).toContain('tab-1:leaf')
    expect(output).toContain('Reset AI')
  })

  it('rejects agent label set without a --label flag', async () => {
    await main(['agent', 'label', 'set', '--terminal', 'term_abc'], userDataPath)

    // Missing required flag short-circuits before any RPC call.
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
