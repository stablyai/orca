import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY } from './agent-launch-identity-capability'
import {
  MOBILE_AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE,
  resolveIdentityCreateTerminalParams
} from './identity-create-terminal-params'

function statusResponse(capabilities: string[]): RpcResponse {
  return { id: 'x', ok: true, result: { capabilities }, _meta: { runtimeId: 'r' } }
}

function capableClient() {
  return {
    sendRequest: vi.fn(async () =>
      statusResponse(['other', MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY])
    )
  }
}

describe('resolveIdentityCreateTerminalParams', () => {
  it('targets the worktree by id', async () => {
    expect((await resolveIdentityCreateTerminalParams(capableClient(), 'wt-1')).worktree).toBe(
      'id:wt-1'
    )
  })

  // oracle-19: mobile launches ride the host-atomic default pick, never a
  // client-cached agent id, so both createTerminal callers send selection:default.
  it('defers agent selection to the host default', async () => {
    expect(
      (await resolveIdentityCreateTerminalParams(capableClient(), 'wt-1')).agentLaunch
    ).toEqual({
      selection: { kind: 'default' },
      allowEmptyPromptLaunch: true
    })
  })

  it('never leaks a client-assembled command, env, or pinned agent', async () => {
    const params = await resolveIdentityCreateTerminalParams(capableClient(), 'wt-1')
    expect(params).not.toHaveProperty('startupCommand')
    expect(params).not.toHaveProperty('env')
    expect(params).not.toHaveProperty('createdWithAgent')
    expect(params.agentLaunch.selection).not.toHaveProperty('agent')
  })

  it('probes the host capability before handing back launch params', async () => {
    const client = capableClient()
    await resolveIdentityCreateTerminalParams(client, 'wt-1')
    expect(client.sendRequest).toHaveBeenCalledWith('status.get')
  })

  // Security regression: a pre-identity host strips agentLaunch and spawns a bare
  // shell, so the caller's provider/AI text would be executed as shell commands.
  it.each([
    ['a host without the capability', async () => statusResponse(['aiVault.v1'])],
    [
      'a failed status probe',
      async (): Promise<RpcResponse> => {
        throw new Error('offline')
      }
    ],
    [
      'a rejected status probe',
      async (): Promise<RpcResponse> => ({
        id: 'x',
        ok: false,
        error: { code: 'E', message: 'nope' },
        _meta: { runtimeId: 'r' }
      })
    ]
  ])('refuses the identity launch for %s', async (_label, sendRequest) => {
    await expect(resolveIdentityCreateTerminalParams({ sendRequest }, 'wt-1')).rejects.toThrow(
      MOBILE_AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE
    )
  })
})
