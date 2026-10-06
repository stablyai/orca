import '../unused-default-rpc-methods.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { closeTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { CAPABLE_CLIENT, methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { RpcDispatcher } from '../dispatcher'

const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
let directory: string
let store: AgentSessionRecordStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-account-pin-replay-'))
  store = await openTestAgentSessionRecordStore(directory)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the terminal launch ledger reads only deps.store from this host double.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  closeTestJournalHostDatabase(directory)
  await rm(directory, { recursive: true, force: true })
})

describe('Codex account launch authoritative receipt replay', () => {
  it.each(['agent.launch', 'agent.launchReplay'] as const)(
    'refuses a nested account that %s would strip instead of pinning',
    (name) => {
      const boundary = methodNamed(AGENT_LAUNCH_METHODS, name)
      expect(() =>
        boundary.params.parse({
          agent: 'codex',
          operationId: `${Date.now()}-000000000000000000000000000000ab`,
          target: {
            kind: 'create-worktree',
            create: { repo: 'id:repo-1', name: 'pinned', startupAccount: 'account-b' }
          }
        })
      ).toThrow('requires account at the launch level')
    }
  )

  it('refuses a pin before returning a warm legacy cache from an unpinned launch', async () => {
    const runtime = { ...runtimeStub({ settings: {} }), getRuntimeId: () => 'test-runtime' }
    const params = {
      agent: 'codex',
      target: {
        kind: 'create-worktree',
        create: { repo: 'id:repo-1', name: 'pinned', clientMutationId: 'same-create' }
      }
    }
    const previous = await method.handler(
      method.params.parse(params),
      rpcContext(runtime, CAPABLE_CLIENT)
    )
    expect(previous.account).toBeUndefined()
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    runtime.resolveAgentLaunchAccount.mockClear()
    runtime.createManagedWorktree.mockClear()
    runtime.createTerminal.mockClear()
    runtime.dedupeWorktreeCreate.mockClear()
    const dispatcher = new RpcDispatcher({
      runtime: rpcContext(runtime, {}).runtime,
      methods: AGENT_LAUNCH_METHODS
    })
    const response = await dispatcher.dispatch(
      {
        id: 'pin-b',
        authToken: 'test-token',
        method: 'agent.launch',
        params: { ...params, account: 'account-b' }
      },
      CAPABLE_CLIENT
    )
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('operationId') }
    })
    expect(runtime.dedupeWorktreeCreate).not.toHaveBeenCalled()
    expect(runtime.resolveAgentLaunchAccount).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it.each(['existing', 'create-worktree'] as const)(
    'records %s launches and replays the pin without resolving or spawning again',
    async (kind) => {
      const operationId = `${Date.now()}-000000000000000000000000000000bb`
      const target =
        kind === 'existing'
          ? { kind, worktree: 'id:wt-7' }
          : {
              kind,
              create: { repo: 'id:repo-1', name: 'pinned', clientMutationId: 'legacy-wrapper' }
            }
      const params = method.params.parse({
        operationId,
        agent: 'codex',
        account: 'B@EXAMPLE.COM',
        target
      })
      const runtime = runtimeStub()
      const result = await method.handler(params, rpcContext(runtime, CAPABLE_CLIENT))
      expect(result).toMatchObject({
        outcome: { kind: 'terminal' },
        receipt: { mode: 'terminal', reason: 'pinned_codex_account' },
        account: {
          provider: 'codex',
          requested: 'b@example.com',
          effective: { id: 'account-b', email: 'b@example.com' }
        }
      })
      if (kind === 'existing') {
        expect(runtime.createTerminal).toHaveBeenCalledWith(
          'id:wt-7',
          expect.objectContaining({ codexAccountId: 'account-b' })
        )
      } else {
        expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ startupAgent: 'codex', startupAccount: 'account-b' })
        )
      }
      const replayRuntime = runtimeStub()
      replayRuntime.resolveAgentLaunchAccount.mockRejectedValue(
        new Error('account removed after launch')
      )
      const replay = await method.handler(params, rpcContext(replayRuntime, CAPABLE_CLIENT))
      expect(replay).toEqual(result)
      expect(replayRuntime.resolveAgentLaunchAccount).not.toHaveBeenCalled()
      expect(replayRuntime.createTerminal).not.toHaveBeenCalled()
      expect(replayRuntime.createManagedWorktree).not.toHaveBeenCalled()
      expect(
        store.listOperationRows().find((row) => row.operationId === operationId)?.outcome.status
      ).toBe('succeeded')
      await expect(
        method.handler({ ...params, account: 'account-a' }, rpcContext(runtime, CAPABLE_CLIENT))
      ).rejects.toThrow('agent_session_operation_conflict')
    }
  )
})
