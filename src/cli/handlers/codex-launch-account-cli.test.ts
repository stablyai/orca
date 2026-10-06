import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { CODEX_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/agent-launch-account'
import { getCodexLaunchAccountFlag } from './codex-launch-account-flag'
import { ORCHESTRATION_HANDLERS } from './orchestration'
import { WORKTREE_HANDLERS } from './worktree'

vi.mock('../format', () => ({ printResult: vi.fn(), formatWorktreeShow: vi.fn() }))

const call = vi.fn()
const receipt = {
  provider: 'codex',
  requested: 'account-b',
  effective: { id: 'account-b', email: 'b@example.com' }
}

function context(entries: Record<string, string | boolean>): HandlerContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers use only client.call; the mock rejects any unexpected RPC in the assertions.
  return {
    flags: new Map(Object.entries(entries)),
    client: { call },
    cwd: '/fixture',
    json: true
  } as unknown as HandlerContext
}

beforeEach(() => call.mockReset())

describe('explicit Codex launch CLI capability boundary', () => {
  const commands: {
    handler: CommandHandler
    base: Record<string, string | boolean>
    method: string
    field: string
  }[] = [
    {
      handler: ORCHESTRATION_HANDLERS['orchestration worker-start'],
      base: { task: 'task_1', from: 'term_coord' },
      method: 'orchestration.workerStart',
      field: 'account'
    },
    {
      handler: WORKTREE_HANDLERS['worktree create'],
      base: { name: 'pinned', repo: 'id:repo_1', 'no-parent': true },
      method: 'worktree.create',
      field: 'startupAccount'
    }
  ]

  it.each(commands)(
    'gates and forwards the selector through $method',
    async ({ handler, base, method, field }) => {
      call
        .mockResolvedValueOnce({
          result: { capabilities: [CODEX_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY] }
        })
        .mockResolvedValue({
          result: {
            state: 'ready',
            worktree: { id: 'wt_1' },
            warnings: [],
            launch: { account: receipt },
            account: receipt
          }
        })
      await handler(context({ ...base, agent: 'codex', account: 'account-b' }))
      expect(call.mock.calls[0]).toEqual(['status.get'])
      const mutation = call.mock.calls.find(([name]) => name === method)
      expect(mutation?.[1]).toHaveProperty(field, 'account-b')
    }
  )

  it.each(commands)(
    'keeps the omitted-flag RPC shape and skips status for $method',
    async ({ handler, base, method, field }) => {
      call.mockResolvedValue({ result: { state: 'ready', worktree: { id: 'wt_1' }, warnings: [] } })
      await handler(context({ ...base, agent: 'codex' }))
      expect(call).not.toHaveBeenCalledWith('status.get')
      expect(call.mock.calls.find(([name]) => name === method)?.[1]).not.toHaveProperty(field)
    }
  )

  it.each([undefined, [], ['agent.launch.v2'], null])(
    'refuses missing/old host capabilities %j before mutation',
    async (capabilities) => {
      call.mockResolvedValue({ result: { capabilities } })
      const ctx = context({ account: 'account-a', agent: 'codex' })
      await expect(getCodexLaunchAccountFlag(ctx.flags, ctx.client)).rejects.toMatchObject({
        code: 'incompatible_runtime'
      })
      expect(call).toHaveBeenCalledExactlyOnceWith('status.get')
    }
  )

  const unsupportedRequests: Record<string, string | boolean>[] = [
    { agent: 'claude' },
    { agent: 'cursor' },
    { agent: 'codex', terminal: 'term_existing' },
    { agent: 'codex', on: 'server' },
    {}
  ]
  it.each(unsupportedRequests)(
    'refuses unsupported provider or placement %j without contacting a host',
    async (flags) => {
      const ctx = context({ account: 'account-a', ...flags })
      await expect(getCodexLaunchAccountFlag(ctx.flags, ctx.client)).rejects.toMatchObject({
        code: 'invalid_argument'
      })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it.each([true, false, '', ' ', 'id\nsecret'])(
    'refuses malformed account flag %j without dropping the pin',
    async (account) => {
      const ctx = context({ account, agent: 'codex' })
      await expect(getCodexLaunchAccountFlag(ctx.flags, ctx.client)).rejects.toMatchObject({
        code: 'invalid_argument'
      })
      expect(call).not.toHaveBeenCalled()
    }
  )
})
