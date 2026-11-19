import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CreateTerminalTab } from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  openTestAgentSessionRecordStore,
  closeTestAgentSessionDatabase
} from '../../../agent-session/records/agent-session-record-store-test-harness'
import {
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from '../agent-launch/agent-launch.test-fixture'
import { runOwnedSessionStartup } from './session-tabs-owned-startup'

it.each(['accepted', 'before-dispatch', 'during-dispatch'])(
  'keeps startup acceptance durable across restart: %s',
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-owned-startup-'))
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
      const context = rpcContext(runtimeStub(), {
        caller: { kind: 'paired-device', deviceId: 'phone' }
      })
      const params = CreateTerminalTab.parse({
        worktree: 'id:workspace',
        command: 'claude --resume source',
        requireOwnedStartup: true,
        clientMutationId: `${now}-000000000000000000000000000000ab`
      })
      const result: RuntimeMobileSessionCreateTerminalResult = {
        tab: {
          type: 'terminal',
          id: 'tab',
          title: 'Claude',
          parentTabId: 'group',
          leafId: '11111111-1111-4111-8111-111111111111',
          isActive: true,
          status: 'ready',
          terminal: 'accepted-terminal'
        },
        publicationEpoch: 'epoch',
        snapshotVersion: 1
      }
      const first = runOwnedSessionStartup(params, context, async (dispatched) => {
        if (phase === 'before-dispatch') {
          throw new Error('refused before startup')
        }
        dispatched?.()
        if (phase === 'during-dispatch') {
          throw new Error('reply lost during startup')
        }
        return result
      })
      await (phase === 'accepted' ? first : expect(first).rejects.toThrow())
      await closeTestAgentSessionDatabase(directory)
      setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
      clock.mockReturnValue(now + 120_000)
      const retry = runOwnedSessionStartup(params, context, async (dispatched) => {
        if (phase !== 'before-dispatch') {
          throw new Error('Command was delivered twice')
        }
        dispatched?.()
        return result
      })
      await (phase === 'during-dispatch'
        ? expect(retry).rejects.toMatchObject({ code: 'agent_session_operation_unknown' })
        : expect(retry).resolves.toMatchObject({ tab: { terminal: 'accepted-terminal' } }))
      clock.mockReturnValue(now + 3 * 24 * 60 * 60 * 1000)
      await expect(
        runOwnedSessionStartup(params, context, async () => {
          throw new Error('Expired startup ran again')
        })
      ).rejects.toMatchObject({ code: 'agent_session_operation_expired' })
    } finally {
      clock.mockRestore()
      setAgentLaunchRecordStore(null)
      await closeTestAgentSessionDatabase(directory)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
