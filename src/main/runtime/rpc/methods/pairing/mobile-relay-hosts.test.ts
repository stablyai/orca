import { describe, expect, it, vi } from 'vitest'
import { MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { RpcContext } from '../../core'
import { MOBILE_RELAY_HOSTS_METHODS } from './mobile-relay-hosts'

const worktreesMethod = MOBILE_RELAY_HOSTS_METHODS.find(
  (method) => method.name === MOBILE_RELAY_HOST_WORKTREES_METHOD
)!

function read(clientCapabilities: readonly string[]) {
  const worktrees = vi.fn(async () => ({ worktrees: null }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these four context fields.
  const ctx = {
    connectionId: 'phone-1',
    clientCapabilities,
    runtime: { registerSubscriptionCleanup: vi.fn() },
    mobileRelayHosts: { list: () => ({ hosts: [] }), worktrees }
  } as unknown as RpcContext
  return {
    worktrees,
    done: worktreesMethod.handler(
      MobileRelayHostWorktreesParamsSchema.parse({ hostId: 'runtime:env-1' }),
      ctx
    )
  }
}

describe('mobileRelay.hosts.worktrees row watch', () => {
  it('watches the server for a phone that reads relayHostRowsChanged', async () => {
    const { worktrees, done } = read([MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY])
    await done
    expect(worktrees).toHaveBeenCalledWith(
      'runtime:env-1',
      expect.objectContaining({ connectionId: 'phone-1' })
    )
  })

  it('opens no watch for an older phone, which never hears the event', async () => {
    const { worktrees, done } = read([])
    await done
    expect(worktrees).toHaveBeenCalledWith('runtime:env-1', undefined)
  })
})
