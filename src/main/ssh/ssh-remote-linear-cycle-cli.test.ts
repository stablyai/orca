import { describe, expect, it, vi } from 'vitest'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { tryDispatchRemoteLinearReadCli } from './ssh-remote-linear-read-cli'
import { tryDispatchRemoteLinearWriteCli } from './ssh-remote-linear-write-cli'

function dispatcher() {
  const dispatch = vi.fn().mockResolvedValue({ id: 'response-1', ok: true, result: {} })
  return { dispatch, value: { dispatch } as unknown as RpcDispatcher }
}

describe('SSH Linear cycle commands', () => {
  it('discovers the current cycle on the execution host', async () => {
    const target = dispatcher()

    await tryDispatchRemoteLinearReadCli(
      target.value,
      {
        commandPath: ['linear', 'team', 'cycles'],
        flags: new Map<string, string | boolean>([
          ['team', 'ENG'],
          ['current', true],
          ['workspace', 'workspace-1']
        ])
      },
      {}
    )

    expect(target.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'linear.agentTeamCycles',
        params: { teamInput: 'ENG', workspaceId: 'workspace-1', currentOnly: true }
      })
    )
  })

  it('assigns the current cycle and clears it on the execution host', async () => {
    const target = dispatcher()
    const env = { ORCA_TERMINAL_HANDLE: 'term-1' }

    await tryDispatchRemoteLinearWriteCli(
      target.value,
      {
        commandPath: ['linear', 'cycle', 'set', 'ENG-1'],
        flags: new Map([['to', 'current']])
      },
      env
    )
    await tryDispatchRemoteLinearWriteCli(
      target.value,
      { commandPath: ['linear', 'cycle', 'clear', 'ENG-1'], flags: new Map() },
      env
    )

    expect(target.dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'linear.issueUpdateTask',
        params: expect.objectContaining({ operation: 'cycle', cycleInput: 'current' })
      })
    )
    expect(target.dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'linear.issueUpdateTask',
        params: expect.objectContaining({ operation: 'cycle', cycleInput: null })
      })
    )
  })
})
