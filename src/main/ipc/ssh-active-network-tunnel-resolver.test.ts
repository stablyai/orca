import { afterEach, expect, it, vi } from 'vitest'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { openRegisteredSshNetworkTunnel } from '../ssh/ssh-target-registry'
import { activeSessions } from './ssh-active-relay-sessions'

const targetId = 'network-tunnel-resolver-test'
afterEach(() => activeSessions.delete(targetId))

function fixture() {
  const opened = {
    tunnel: { fail: vi.fn() },
    connection: {},
    assertCurrent: vi.fn(),
    assertAdmission: vi.fn(),
    release: vi.fn(async () => {})
  }
  const open = vi.fn(async () => opened)
  const session = { openNetworkTunnel: open } as unknown as SshRelaySession
  activeSessions.set(targetId, session)
  return { opened, open, session }
}

it('refuses an absent session without connecting or deploying a replacement', async () => {
  await expect(openRegisteredSshNetworkTunnel(targetId)).rejects.toThrow('session_unavailable')
})

it('passes cancellation and failure observation to the session-owned opener', async () => {
  const f = fixture()
  const options = { signal: new AbortController().signal, onFailure: vi.fn() }
  const result = await openRegisteredSshNetworkTunnel(targetId, options)

  expect(f.open).toHaveBeenCalledExactlyOnceWith(options)
  expect(result.connection).toBe(f.opened.connection)
  expect(result.tunnel).toBe(f.opened.tunnel)
  result.assertAdmission()
  expect(f.opened.assertAdmission).toHaveBeenCalledOnce()
  expect(f.opened.tunnel.fail).not.toHaveBeenCalled()
})

it('retains uncertainty when a session is replaced while opening', async () => {
  const f = fixture()
  const ready = Promise.withResolvers<typeof f.opened>()
  f.open.mockReturnValueOnce(ready.promise)
  const opening = openRegisteredSshNetworkTunnel(targetId)
  activeSessions.set(targetId, {} as SshRelaySession)
  ready.resolve(f.opened)

  await expect(opening).rejects.toThrow('session_changed')
  expect(f.opened.tunnel.fail).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'ssh_network_tunnel_session_changed' })
  )
  expect(f.opened.release).not.toHaveBeenCalled()
})

it('rechecks registry identity but keeps release bound to the original cohort', async () => {
  const f = fixture()
  const result = await openRegisteredSshNetworkTunnel(targetId)
  activeSessions.set(targetId, {} as SshRelaySession)

  expect(result.assertCurrent).toThrow('session_changed')
  expect(result.assertAdmission).toThrow('session_changed')
  const signal = new AbortController().signal
  await result.release(signal)
  expect(f.opened.release).toHaveBeenCalledExactlyOnceWith(signal)
})

it('preserves the binding failure if opening finishes under stale ownership', async () => {
  const f = fixture()
  const error = new Error('owner replaced')
  f.opened.assertCurrent.mockImplementation(() => {
    throw error
  })

  await expect(openRegisteredSshNetworkTunnel(targetId)).rejects.toBe(error)
  expect(f.opened.tunnel.fail).toHaveBeenCalledExactlyOnceWith(error)
})
