import { describe, expect, it, vi } from 'vitest'
import { MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { RpcContext } from '../../core'
import type { RelayPhoneReader } from '../../../mobile-desktop-relay/mobile-relay-host-rows-announcer'
import { MOBILE_RELAY_HOSTS_METHODS } from './mobile-relay-hosts'

const worktreesMethod = MOBILE_RELAY_HOSTS_METHODS.find(
  (entry) => entry.name === MOBILE_RELAY_HOST_WORKTREES_METHOD
)!
const listMethod = MOBILE_RELAY_HOSTS_METHODS.find(
  (entry) => entry.name === MOBILE_RELAY_HOSTS_LIST_METHOD
)!

function phone(clientCapabilities: readonly string[], signal?: AbortSignal) {
  const worktrees = vi.fn(async (_hostId: string, _by?: RelayPhoneReader) => ({ worktrees: null }))
  const list = vi.fn((_by?: RelayPhoneReader) => ({ hosts: [] }))
  const registerSubscriptionCleanup = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these context fields.
  const ctx = {
    connectionId: 'phone-1',
    clientCapabilities,
    signal,
    runtime: { registerSubscriptionCleanup },
    mobileRelayHosts: { list, worktrees }
  } as unknown as RpcContext
  const readRows = () =>
    worktreesMethod.handler(
      MobileRelayHostWorktreesParamsSchema.parse({ hostId: 'runtime:env-1' }),
      ctx
    )
  const readList = () => listMethod.handler(undefined, ctx)
  return { worktrees, list, registerSubscriptionCleanup, readRows, readList }
}

const CAPABLE = [MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY]

describe('mobileRelay.hosts holds', () => {
  it('watches the server for a phone that reads relayHostRowsChanged', async () => {
    const { worktrees, readRows } = phone(CAPABLE)
    await readRows()
    expect(worktrees).toHaveBeenCalledWith(
      'runtime:env-1',
      expect.objectContaining({ connectionId: 'phone-1' })
    )
  })

  it('opens no watch for an older phone, which never hears the event', async () => {
    const { worktrees, list, readRows, readList } = phone([])
    await readRows()
    await readList()
    expect(worktrees).toHaveBeenCalledWith('runtime:env-1', undefined)
    expect(list).toHaveBeenCalledWith(undefined)
  })

  it('holds the host list watch for a capable phone that reads the list', async () => {
    const { list, readList } = phone(CAPABLE)
    await readList()
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'phone-1' }))
  })

  it('releases at once for a phone that left while its read awaited', async () => {
    const controller = new AbortController()
    const { worktrees, registerSubscriptionCleanup, readRows } = phone(CAPABLE, controller.signal)
    await readRows()
    controller.abort()
    const release = vi.fn()
    worktrees.mock.calls[0]?.[1]?.onClose(release)
    expect(release).toHaveBeenCalledTimes(1)
    expect(registerSubscriptionCleanup).not.toHaveBeenCalled()
  })
})
