import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_SPLIT_ENV_RUNTIME_CAPABILITY,
  TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY
} from '../shared/terminal-runtime-capabilities'
import { TerminalCreateParams, TerminalSplit } from '../shared/rpc-contract/terminal-unary-params'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  getCliStatusMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-env-test')
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  const module = await createRuntimeClientModuleMock(mocks)
  class RuntimeClient extends module.RuntimeClient {
    getCliStatus = mocks.getCliStatusMock
  }
  return { ...module, RuntimeClient }
})

import { main } from './index'
import { okFixture } from './test-fixtures'

const originalExitCode = process.exitCode
const command = 'echo keep-this-command'

function argumentsFor(operation: 'create' | 'split'): string[] {
  return operation === 'create'
    ? ['terminal', 'create', '--worktree', 'id:ssh-project::/srv/repo']
    : ['terminal', 'split', '--terminal', 'term-server-owned', '--direction', 'vertical']
}

describe('terminal environment flags', () => {
  beforeEach(() => {
    mocks.callMock.mockReset()
    mocks.getCliStatusMock.mockReset().mockResolvedValue({
      result: {
        runtime: { reachable: true, capabilities: [TERMINAL_SPLIT_ENV_RUNTIME_CAPABILITY] }
      }
    })
    process.exitCode = undefined
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_REMOTE_PAIRING', '')
    vi.stubEnv('ORCA_TEST_ENV_ONE', 'parent')
    vi.stubEnv('ORCA_TEST_ENV_TWO', '')
    vi.stubEnv('ORCA_TEST_ENV_EMPTY', 'parent')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = originalExitCode
  })

  it.each(['create', 'split'] as const)(
    '%s delivers repeated values as environment data without rewriting the command',
    async (operation) => {
      const environments: unknown[] = []
      const commands: (string | undefined)[] = []
      mocks.callMock.mockImplementation(async (method: string, input: unknown) => {
        expect(method).toBe(`terminal.${operation}`)
        const params =
          operation === 'create' ? TerminalCreateParams.parse(input) : TerminalSplit.parse(input)
        commands.push(params.command)
        const child = runProcessSync({
          program: process.execPath,
          args: [
            '-e',
            'process.stdout.write(JSON.stringify([process.env.ORCA_TEST_ENV_ONE, process.env.ORCA_TEST_ENV_TWO, process.env.ORCA_TEST_ENV_EMPTY]))'
          ],
          env: { ...process.env, ...params.env },
          timeoutMs: 5000
        })
        expect(child.code).toBe(0)
        const environment: unknown = JSON.parse(child.stdout)
        environments.push(environment)
        return okFixture('req-env', {
          [operation === 'create' ? 'terminal' : 'split']: { handle: 'term-created' }
        })
      })

      await main(
        [
          ...argumentsFor(operation),
          '--command',
          command,
          '--env',
          'ORCA_TEST_ENV_ONE=first',
          '--env',
          'ORCA_TEST_ENV_TWO=two words=with=equals',
          '--env',
          'ORCA_TEST_ENV_EMPTY=',
          '--env',
          'ORCA_TEST_ENV_ONE=last',
          '--json'
        ],
        '/tmp/not-an-orca-worktree'
      )

      expect(environments).toEqual([['last', 'two words=with=equals', '']])
      expect(commands).toEqual([command])
      expect(process.env.ORCA_TEST_ENV_ONE).toBe('parent')
      expect(process.exitCode).toBeUndefined()
    }
  )

  it.each(['create', 'split'] as const)(
    '%s leaves the environment override absent by default',
    async (operation) => {
      const overrides: unknown[] = []
      mocks.callMock.mockImplementation(async (_method: string, input: unknown) => {
        const params =
          operation === 'create' ? TerminalCreateParams.parse(input) : TerminalSplit.parse(input)
        overrides.push(params.env)
        return okFixture('req-env', {
          [operation === 'create' ? 'terminal' : 'split']: { handle: 'term-created' }
        })
      })

      await main([...argumentsFor(operation), '--json'], '/tmp/not-an-orca-worktree')

      expect(overrides).toEqual([undefined])
      expect(mocks.getCliStatusMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBeUndefined()
    }
  )

  it.each(['create', 'split'] as const)(
    '%s rejects malformed assignments before sending a request',
    async (operation) => {
      for (const assignment of ['SECRET_VALUE', '=SECRET_VALUE', 'BAD-KEY=SECRET_VALUE', '']) {
        const log = vi.mocked(console.log)
        log.mockClear()
        await main(
          [...argumentsFor(operation), '--env', assignment, '--json'],
          '/tmp/not-an-orca-worktree'
        )
        const output = JSON.parse(String(log.mock.calls[0]?.[0]))
        expect(output.error.code).toBe('invalid_argument')
        expect(output.error.message).toContain('KEY=VALUE')
        expect(output.error.message).not.toContain('SECRET_VALUE')
        expect(process.exitCode).toBe(1)
      }
      expect(mocks.callMock).not.toHaveBeenCalled()
    }
  )

  it.each(['create', 'split'] as const)(
    '%s rejects a malformed occurrence mixed with valid assignments',
    async (operation) => {
      for (const envArgs of [
        ['--env', '', '--env', 'GOOD=value'],
        ['--env', 'GOOD=value', '--env', ''],
        ['--env', '--env', 'GOOD=value']
      ]) {
        const log = vi.mocked(console.log)
        log.mockClear()
        await main([...argumentsFor(operation), ...envArgs, '--json'], '/tmp/not-an-orca-worktree')
        const output = JSON.parse(String(log.mock.calls[0]?.[0]))
        expect(output.error.code).toBe('invalid_argument')
        expect(process.exitCode).toBe(1)
      }
      expect(mocks.callMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { reachable: true, capabilities: [], code: 'incompatible_runtime' },
    { reachable: false, capabilities: [], code: 'runtime_unavailable' }
  ])(
    'refuses split env before mutation when host status is %j',
    async ({ reachable, capabilities, code }) => {
      mocks.getCliStatusMock.mockResolvedValue({ result: { runtime: { reachable, capabilities } } })
      await main(
        [...argumentsFor('split'), '--env', 'GOOD=value', '--json'],
        '/tmp/not-an-orca-worktree'
      )
      const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))
      expect(output.error.code).toBe(code)
      expect(mocks.callMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
    }
  )

  it.each(['create', 'split'] as const)('%s refuses --env without a value', async (operation) => {
    await main([...argumentsFor(operation), '--env', '--json'], '/tmp/not-an-orca-worktree')

    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))
    expect(output.error.code).toBe('invalid_argument')
    expect(output.error.message).toContain('--env requires a value')
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it.each([
    [TERMINAL_SPLIT_ENV_RUNTIME_CAPABILITY, TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY],
    [TERMINAL_SPLIT_ENV_RUNTIME_CAPABILITY],
    [TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY]
  ])(
    'checks both capabilities when env overrides accompany a split retry: %j',
    async (...capabilities) => {
      mocks.getCliStatusMock.mockResolvedValue({
        result: { runtime: { reachable: true, capabilities } }
      })
      const received: unknown[] = []
      mocks.callMock.mockImplementation(async (_method, input) => {
        received.push(TerminalSplit.parse(input))
        return okFixture('retry-env', { split: { handle: 'term-existing' } })
      })
      await main(
        [
          ...argumentsFor('split'),
          '--retry-split',
          'leaf-pending',
          '--env',
          'GOOD=two words=ok',
          '--json'
        ],
        '/tmp/not-an-orca-worktree'
      )
      if (capabilities.length === 2) {
        expect(received).toEqual([
          expect.objectContaining({ retrySplit: 'leaf-pending', env: { GOOD: 'two words=ok' } })
        ])
        expect(process.exitCode).toBeUndefined()
      } else {
        expect(received).toEqual([])
        expect(process.exitCode).toBe(1)
        expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])).error.code).toBe(
          'incompatible_runtime'
        )
      }
    }
  )
})
