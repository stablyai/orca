import { afterEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal } }))

import {
  clearRemoteOpenUrlTicketsForTests,
  issueRemoteOpenUrlTicket
} from '../ssh/remote-open-url-requests'
import { approveRemoteOpenUrl, oauthCallbackForwarder } from './ssh-remote-open-url-approval'

const withCallback = `https://auth.example/authorize?redirect_uri=${encodeURIComponent(
  'http://localhost:1455/auth/callback'
)}`

afterEach(() => {
  vi.restoreAllMocks()
  openExternal.mockClear()
  clearRemoteOpenUrlTicketsForTests()
})

describe('approveRemoteOpenUrl', () => {
  it('opens only the URL main recorded, once', async () => {
    const { requestId } = issueRemoteOpenUrlTicket({
      url: 'https://auth.example/device',
      sshTargetId: 't1'
    })
    expect(await approveRemoteOpenUrl(requestId)).toEqual({
      status: 'opened',
      forwardedPort: null,
      forwardMinutes: null
    })
    expect(openExternal).toHaveBeenCalledWith('https://auth.example/device')
    expect(await approveRemoteOpenUrl(requestId)).toEqual({ status: 'expired' })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('opens nothing for an id main never issued', async () => {
    expect(await approveRemoteOpenUrl('forged')).toEqual({ status: 'expired' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('forwards the loopback callback for the calling host before opening', async () => {
    const start = vi
      .spyOn(oauthCallbackForwarder, 'start')
      .mockResolvedValue({ ok: true, port: 1455, lifetimeMs: 300_000 })
    const { requestId } = issueRemoteOpenUrlTicket({ url: withCallback, sshTargetId: 't1' })

    expect(await approveRemoteOpenUrl(requestId)).toEqual({
      status: 'opened',
      forwardedPort: 1455,
      forwardMinutes: 5
    })
    expect(start).toHaveBeenCalledWith('t1', {
      host: 'localhost',
      port: 1455,
      path: '/auth/callback'
    })
    expect(openExternal).toHaveBeenCalledWith(withCallback)
  })

  it('does not open a sign-in whose callback cannot be forwarded', async () => {
    vi.spyOn(oauthCallbackForwarder, 'start').mockResolvedValue({
      ok: false,
      reason: 'port_in_use'
    })
    const { requestId } = issueRemoteOpenUrlTicket({ url: withCallback, sshTargetId: 't1' })

    expect(await approveRemoteOpenUrl(requestId)).toEqual({
      status: 'forward_failed',
      reason: 'port_in_use',
      port: 1455
    })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
