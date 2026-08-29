import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { PinnedWorktreeDisplayPolicy } from '../../../src/shared/worktree/pinned-display-policy'
import { usePinnedWorkspaceDisplayPolicy } from './use-pinned-workspace-display-policy'

type Pending = { resolve: (response: unknown) => void; reject: (err: Error) => void }

/** Mounts the hook against a deferred settings.get so a test decides what the host answers. */
function mountPolicy(connState: ConnectionState = 'connected') {
  const pending: Pending[] = []
  const requests: string[] = []
  let latest: PinnedWorktreeDisplayPolicy = 'single-location'

  const client = {
    sendRequest: (method: string) => {
      requests.push(method)
      return new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject }))
    }
  } as unknown as RpcClient

  function Probe({ state }: { state: ConnectionState }) {
    latest = usePinnedWorkspaceDisplayPolicy(client, state)
    return null
  }

  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe, { state: connState }))
  })

  return {
    get policy(): PinnedWorktreeDisplayPolicy {
      return latest
    },
    requests,
    setConnState(next: ConnectionState) {
      act(() => {
        renderer.update(createElement(Probe, { state: next }))
      })
    },
    async settle(settings: unknown) {
      await act(async () => {
        pending[0]!.resolve({ ok: true, result: { settings } })
        await Promise.resolve()
      })
    },
    async settleRaw(response: unknown) {
      await act(async () => {
        pending[0]!.resolve(response)
        await Promise.resolve()
      })
    },
    async fail() {
      await act(async () => {
        pending[0]!.reject(new Error('host unreachable'))
        await Promise.resolve()
      })
    }
  }
}

describe('usePinnedWorkspaceDisplayPolicy', () => {
  it('duplicates in groups when the desktop opted in', async () => {
    const probe = mountPolicy()
    await probe.settle({ showPinnedWorktreesInGroups: true })
    expect(probe.policy).toBe('duplicate-in-groups')
  })

  it('stays single-location when the setting is false', async () => {
    const probe = mountPolicy()
    await probe.settle({ showPinnedWorktreesInGroups: false })
    expect(probe.policy).toBe('single-location')
  })

  it('stays single-location when an older host omits the field', async () => {
    const probe = mountPolicy()
    await probe.settle({ compactWorktreeCards: true })
    expect(probe.policy).toBe('single-location')
  })

  it('stays single-location for a non-boolean value', async () => {
    const probe = mountPolicy()
    await probe.settle({ showPinnedWorktreesInGroups: 'yes' })
    expect(probe.policy).toBe('single-location')
  })

  it('stays single-location when the request fails', async () => {
    const probe = mountPolicy()
    await probe.fail()
    expect(probe.policy).toBe('single-location')
  })

  it('stays single-location when the host reports an error response', async () => {
    const probe = mountPolicy()
    await probe.settleRaw({ ok: false, error: { code: 'unavailable' } })
    expect(probe.policy).toBe('single-location')
  })

  it('issues no request while disconnected', () => {
    expect(mountPolicy('reconnecting').requests).toEqual([])
  })

  // The host screen keeps rendering the pre-reconnect list while amber, so dropping back to the
  // default here would silently reflow a frozen list for an opted-in user (#15494).
  it('keeps the opted-in policy across a reconnect blip', async () => {
    const probe = mountPolicy()
    await probe.settle({ showPinnedWorktreesInGroups: true })

    probe.setConnState('reconnecting')
    expect(probe.policy).toBe('duplicate-in-groups')

    probe.setConnState('disconnected')
    expect(probe.policy).toBe('duplicate-in-groups')
    expect(probe.requests).toEqual(['settings.get'])
  })
})
