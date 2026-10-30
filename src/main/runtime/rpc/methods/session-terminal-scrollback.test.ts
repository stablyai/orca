import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-runtime-capabilities'
import { ORCA_E2E_WSL_MOVE_DESTINATION_ENV } from '../../../orcad/orcad-migration-wsl-destination'
import { SESSION_TERMINAL_SCROLLBACK_METHODS } from './session-terminal-scrollback'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { SessionReadTerminalScrollbackParams } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'

afterEach(() => {
  vi.unstubAllEnvs()
})

const REF = `v1-${'0'.repeat(32)}`

function dispatcherForThisHost() {
  const readTerminalScrollbackForClient = vi.fn(async () => ({ buffer: 'moved history' }))
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The method's handler reads only readTerminalScrollbackForClient and getRuntimeId.
    runtime: {
      getRuntimeId: () => 'runtime-1',
      readTerminalScrollbackForClient
    } as unknown as OrcaRuntimeService,
    methods: SESSION_TERMINAL_SCROLLBACK_METHODS
  })
  const read = (params: unknown) =>
    dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'session.readTerminalScrollback',
      params
    })
  return { read, readTerminalScrollbackForClient }
}

describe('session.readTerminalScrollback', () => {
  it('is registered, validates its params and reads on a WSL move destination', async () => {
    vi.stubEnv(ORCA_E2E_WSL_MOVE_DESTINATION_ENV, '1')
    const { read, readTerminalScrollbackForClient } = dispatcherForThisHost()
    expect(await read({ worktree: 'id:repo::/wt', ref: REF })).toMatchObject({
      ok: true,
      result: { buffer: 'moved history' }
    })
    expect(readTerminalScrollbackForClient).toHaveBeenCalledWith({
      worktree: 'id:repo::/wt',
      ref: REF
    })
    expect(await read({ worktree: 'id:repo::/wt', ref: '../secrets' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(readTerminalScrollbackForClient).toHaveBeenCalledTimes(1)
    expect(SESSION_TERMINAL_SCROLLBACK_METHODS[0]?.permission).toBe('workspace')
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('session.readTerminalScrollback')).toBe(true)
  })

  it('is absent, and not advertised by default, on every other host', async () => {
    const { read, readTerminalScrollbackForClient } = dispatcherForThisHost()
    expect(await read({ worktree: 'id:repo::/wt', ref: REF })).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
    expect(readTerminalScrollbackForClient).not.toHaveBeenCalled()
    expect(RUNTIME_CAPABILITIES).not.toContain(SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY)
  })

  it('accepts only snapshot-shaped refs and a worktree selector', () => {
    const ok = { worktree: 'id:repo::/wt', ref: `v1-${'0'.repeat(32)}` }
    expect(SessionReadTerminalScrollbackParams.safeParse(ok).success).toBe(true)
    for (const ref of ['../secrets', `v1-${'0'.repeat(31)}`, 'v1-ZZ', '']) {
      expect(SessionReadTerminalScrollbackParams.safeParse({ ...ok, ref }).success).toBe(false)
    }
    expect(
      SessionReadTerminalScrollbackParams.safeParse({ ref: ok.ref, worktree: '' }).success
    ).toBe(false)
  })
})
