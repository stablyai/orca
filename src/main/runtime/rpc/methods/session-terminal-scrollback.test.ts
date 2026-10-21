import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-runtime-capabilities'
import { SessionReadTerminalScrollbackParams } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { ALL_RPC_METHODS } from './index'

describe('session.readTerminalScrollback', () => {
  it('is registered once as a workspace method and advertised by capability', () => {
    const methods = ALL_RPC_METHODS.filter(
      (method) => method.name === 'session.readTerminalScrollback'
    )
    expect(methods).toHaveLength(1)
    expect(methods[0]?.permission).toBe('workspace')
    expect(RUNTIME_CAPABILITIES).toContain(SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('session.readTerminalScrollback')).toBe(true)
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
