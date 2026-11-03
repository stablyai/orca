import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { MOBILE_RELAY_HOSTS_METHODS } from './mobile-relay-hosts'
import type { z } from 'zod'
import type {
  MobileRelayHostWorktreesParamsSchema,
  MobileRelayServerWorktreeRow
} from '../../../../shared/mobile-relay-hosts-contract'

const row = (worktreeId: string, displayName = worktreeId): MobileRelayServerWorktreeRow => ({
  hostId: 'runtime:env-1',
  worktreeId,
  displayName
})

function relay(...served: (MobileRelayServerWorktreeRow[] | null)[]) {
  const worktrees = vi.fn(async () => ({ worktrees: served.shift() ?? null }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the runtime id; these methods read none.
  const runtime = { getRuntimeId: () => 'desktop' } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_RELAY_HOSTS_METHODS })
  return async (
    params: Omit<z.input<typeof MobileRelayHostWorktreesParamsSchema>, 'hostId'>
  ): Promise<Record<string, unknown>> => {
    let result: Record<string, unknown> = {}
    await dispatcher.dispatchStreaming(
      {
        id: 'r',
        authToken: 'token',
        method: 'mobileRelay.hosts.worktrees',
        params: { hostId: 'runtime:env-1', ...params }
      },
      (reply) => {
        result = JSON.parse(reply).result
      },
      { mobileRelayHosts: { list: () => ({ hosts: [] }), worktrees } }
    )
    return result
  }
}

describe('mobileRelay.hosts.worktrees snapshots', () => {
  it('answers callers that send no snapshot fields exactly as before', async () => {
    const read = relay([row('a')], null)

    expect(await read({})).toEqual({ worktrees: [row('a')] })
    expect(await read({})).toEqual({ worktrees: null })
  })
})
