import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../index'

const client = vi.hoisted(() => ({ call: vi.fn(), created: [] as unknown[][] }))
vi.mock('../runtime-client', () => {
  class RuntimeRpcFailureError extends Error {}
  return {
    RuntimeClient: class {
      call = client.call
      constructor(...args: unknown[]) {
        client.created.push(args)
      }
    },
    RuntimeClientError: Error,
    RuntimeRpcFailureError,
    getDefaultUserDataPath: () => '/unused/user-data'
  }
})

const TOKEN = '0123456789abcdef0123456789abcdef'
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!

function pipeArgs(args: string[]): void {
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([Buffer.from(args.map((arg) => `${arg}\0`).join(''))])
  })
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', stdin)
  client.call.mockReset()
  client.created.length = 0
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

const check = () => main(['agent', 'saved-restore-check', '--agent', 'claude', '--token', TOKEN])

it("asks the local runtime with the invocation's own arguments and roots, and exits 75 for fresh", async () => {
  vi.stubEnv('ORCA_SAVED_RESTORE_BUDGET_MS', '4000')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/profiles/b')
  // A paired environment selected in the pane never redirects this check.
  vi.stubEnv('ORCA_ENVIRONMENT', 'remote-box')
  pipeArgs(['--resume', 'X', "a b'c"])
  client.call.mockResolvedValue({ result: { fresh: true } })
  await check()
  expect(process.exitCode).toBe(75)
  expect(client.call).toHaveBeenCalledWith(
    'agentHooks.savedRestore',
    expect.objectContaining({
      phase: 'check',
      token: TOKEN,
      agent: 'claude',
      args: ['--resume', 'X', "a b'c"],
      roots: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/profiles/b' })
    }),
    expect.objectContaining({ timeoutMs: expect.any(Number) })
  )
  expect(client.created[0]?.slice(2, 4)).toEqual([null, null])
})

it('retries until the runtime listens, and resumes on its refusal or once the budget is spent', async () => {
  vi.stubEnv('ORCA_SAVED_RESTORE_BUDGET_MS', '4000')
  pipeArgs(['--resume', 'X'])
  client.call
    .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    .mockResolvedValueOnce({ result: { fresh: false } })
  await check()
  expect(client.call).toHaveBeenCalledTimes(2)
  expect(process.exitCode).toBeUndefined()

  vi.stubEnv('ORCA_SAVED_RESTORE_BUDGET_MS', '0')
  pipeArgs(['--resume', 'X'])
  client.call.mockReset()
  await check()
  expect(client.call).not.toHaveBeenCalled()
  expect(process.exitCode).toBeUndefined()
})

it('reports a fresh dispatch without reading arguments or waiting on an answer', async () => {
  client.call.mockRejectedValue(new Error('gone'))
  await main(['agent', 'saved-restore-check', '--phase', 'dispatched', '--token', TOKEN])
  expect(client.call).toHaveBeenCalledWith(
    'agentHooks.savedRestore',
    { phase: 'dispatched', token: TOKEN },
    { timeoutMs: 5_000 }
  )
  expect(process.exitCode).toBeUndefined()
})
