import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  applyAgentStatusHooksEnabledMock,
  constructorArgsMock,
  moduleEvaluationMock,
  callMock,
  getCliStatusMock,
  testUserDataPathRef
} = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn(async () => []),
  constructorArgsMock: vi.fn(),
  moduleEvaluationMock: vi.fn(),
  callMock: vi.fn(),
  getCliStatusMock: vi.fn(),
  testUserDataPathRef: { current: '' }
}))

// Explicit environment selectors must resolve before the client is constructed.
vi.mock('./runtime/environments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    listEnvironments: () => [{ id: 'env-1', name: 'env-1' }]
  }
})

// Stub hook writes: this suite runs real handlers that would otherwise edit the developer's agent configs.
vi.mock('../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: vi.fn(() => [])
}))

vi.mock('./runtime-client', () => {
  moduleEvaluationMock()
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
    openOrca = vi.fn()

    constructor(...args: unknown[]) {
      constructorArgsMock(...args)
    }
  }
  return { RuntimeClient, getDefaultUserDataPath: () => testUserDataPathRef.current }
})

import { main } from './index'
import * as dispatchModule from './dispatch'

const evaluationsBeforeMain = moduleEvaluationMock.mock.calls.length

describe('RuntimeClient module-graph deferral', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    testUserDataPathRef.current = mkdtempSync(join(tmpdir(), 'orca-runtime-deferral-userdata-'))
    applyAgentStatusHooksEnabledMock.mockClear()
    constructorArgsMock.mockClear()
    callMock.mockReset()
    getCliStatusMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    vi.unstubAllEnvs()
    rmSync(testUserDataPathRef.current, { recursive: true, force: true })
    process.exitCode = 0
  })

  it('does not evaluate the runtime-client module before main', () => {
    expect(evaluationsBeforeMain).toBe(0)
  })

  it('constructs no client for --help', async () => {
    await main(['--help'], '/tmp/repo')
    expect(constructorArgsMock).not.toHaveBeenCalled()
  })

  it('constructs no client for an unknown flag', async () => {
    await main(['worktree', 'list', '--nope'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(constructorArgsMock).not.toHaveBeenCalled()
  })

  // Assert construction counts before arguments; otherwise an unused getter would pass vacuously.
  const SUPPRESSED_GROUPS: [name: string, argv: string[], constructs: number][] = [
    ['agent', ['agent', 'hooks', 'off'], 1],
    ['environment', ['environment', 'list'], 0],
    ['serve', ['serve'], 0],
    ['vm', ['vm', 'recipe', 'doctor'], 0],
    ['agent-context', ['agent-context'], 0]
  ]

  it.each(SUPPRESSED_GROUPS)(
    'constructs exactly %s expected clients, with null remote selection',
    async (_name, argv, constructs) => {
      vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
      vi.stubEnv('ORCA_ENVIRONMENT', 'some-environment')
      getCliStatusMock.mockResolvedValue({
        result: { runtime: { reachable: false }, app: { running: false } }
      })

      await main(argv, '/tmp/repo')

      const calls = constructorArgsMock.mock.calls
      expect(calls.length, `${argv.join(' ')} client constructions`).toBe(constructs)
      for (const call of calls) {
        expect(call[2], `${argv.join(' ')} pairing code`).toBeNull()
        expect(call[3], `${argv.join(' ')} environment`).toBeNull()
      }
      if (argv.join(' ') === 'agent hooks off') {
        expect(
          applyAgentStatusHooksEnabledMock,
          `${argv.join(' ')} hook application`
        ).toHaveBeenCalledExactlyOnceWith(false, {
          agentCmdOverrides: {},
          disabledTuiAgents: []
        })
      } else {
        expect(
          applyAgentStatusHooksEnabledMock,
          `${argv.join(' ')} hook application`
        ).not.toHaveBeenCalled()
      }
    }
  )

  // Probe the getter directly: handlers that never use it cannot verify null selector forwarding.
  it.each(SUPPRESSED_GROUPS.map(([name, argv]) => [name, argv] as const))(
    'forwards null remote selection to the client %s would build',
    async (_name, argv) => {
      vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
      vi.stubEnv('ORCA_ENVIRONMENT', 'some-environment')
      const dispatchSpy = vi.spyOn(dispatchModule, 'dispatch').mockResolvedValue(undefined)
      try {
        await main(argv, '/tmp/repo')

        const ctx = dispatchSpy.mock.calls.at(-1)?.[1]
        expect(dispatchSpy, `${argv.join(' ')} reached dispatch`).toHaveBeenCalledTimes(1)
        void ctx?.client
        expect(constructorArgsMock, `${argv.join(' ')} constructions`).toHaveBeenCalledTimes(1)
        const [, , pairingCode, environment] = constructorArgsMock.mock.calls[0]
        expect(pairingCode, `${argv.join(' ')} pairing code`).toBeNull()
        expect(environment, `${argv.join(' ')} environment`).toBeNull()
      } finally {
        dispatchSpy.mockRestore()
      }
    }
  )

  it('forwards undefined remote selection for a non-suppressed group', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
    const dispatchSpy = vi.spyOn(dispatchModule, 'dispatch').mockResolvedValue(undefined)
    try {
      await main(['worktree', 'list'], '/tmp/repo')

      void dispatchSpy.mock.calls.at(-1)?.[1]?.client
      expect(constructorArgsMock).toHaveBeenCalledTimes(1)
      const [, , pairingCode, environment] = constructorArgsMock.mock.calls[0]
      expect(pairingCode).toBeUndefined()
      expect(environment).toBeUndefined()
    } finally {
      dispatchSpy.mockRestore()
    }
  })

  it('forwards undefined for non-suppressed commands so the env fallback applies', async () => {
    callMock.mockResolvedValue({ result: { worktrees: [] } })

    await main(['worktree', 'list', '--json'], '/tmp/repo')

    expect(constructorArgsMock).toHaveBeenCalled()
    const [, , pairingCode, environment] = constructorArgsMock.mock.calls[0]
    expect(pairingCode).toBeUndefined()
    expect(environment).toBeUndefined()
  })

  it('forwards explicit --pairing-code and --environment values verbatim', async () => {
    callMock.mockResolvedValue({ result: { worktrees: [] } })

    await main(['worktree', 'list', '--pairing-code', 'code-1', '--json'], '/tmp/repo')
    expect(constructorArgsMock.mock.calls[0][2]).toBe('code-1')
    expect(constructorArgsMock.mock.calls[0][3]).toBeUndefined()

    constructorArgsMock.mockClear()
    await main(['worktree', 'list', '--environment', 'env-1', '--json'], '/tmp/repo')
    expect(constructorArgsMock.mock.calls[0][2]).toBeUndefined()
    expect(constructorArgsMock.mock.calls[0][3]).toBe('env-1')
  })

  it('reuses one client instance across repeated ctx.client reads', async () => {
    callMock.mockResolvedValue({ result: { worktrees: [] } })

    await main(['worktree', 'list', '--json'], '/tmp/repo')

    expect(constructorArgsMock).toHaveBeenCalledTimes(1)
  })
})
