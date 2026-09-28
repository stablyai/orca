import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRemoteOpenUrlTicketsForTests,
  consumeRemoteOpenUrlTicket,
  issueRemoteOpenUrlTicket,
  parseLoopbackCallback
} from './remote-open-url-requests'

function authorize(redirect: string): string {
  return `https://auth.example/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(redirect)}`
}

afterEach(() => clearRemoteOpenUrlTicketsForTests())

describe('parseLoopbackCallback', () => {
  it('finds the loopback callback the CLIs use', () => {
    expect(parseLoopbackCallback(authorize('http://localhost:1455/auth/callback'))).toEqual({
      host: 'localhost',
      port: 1455,
      path: '/auth/callback'
    })
    expect(parseLoopbackCallback(authorize('http://127.0.0.1:54545/callback?x=1'))).toEqual({
      host: '127.0.0.1',
      port: 54545,
      path: '/callback'
    })
  })

  it('ignores anything that is not a plain-http loopback callback with a path', () => {
    for (const redirect of [
      'https://localhost:1455/callback',
      'http://evil.example:1455/callback',
      'http://127.0.0.2:1455/callback',
      'http://[::1]:1455/callback',
      'http://user:pw@localhost:1455/callback',
      'http://localhost/callback',
      'http://localhost:80/callback',
      'http://localhost:1455/',
      'not a url'
    ]) {
      expect(parseLoopbackCallback(authorize(redirect))).toBeNull()
    }
    expect(parseLoopbackCallback('https://auth.example/device')).toBeNull()
  })
})

describe('remote open-url tickets', () => {
  it('can be used once, then never again', () => {
    const { requestId } = issueRemoteOpenUrlTicket({ url: 'https://a.example/', sshTargetId: 't1' })
    expect(consumeRemoteOpenUrlTicket(requestId)?.sshTargetId).toBe('t1')
    expect(consumeRemoteOpenUrlTicket(requestId)).toBeNull()
  })

  it('rejects forged, malformed and expired ids', () => {
    const { requestId } = issueRemoteOpenUrlTicket(
      { url: 'https://a.example/', sshTargetId: 't1' },
      1_000
    )
    expect(consumeRemoteOpenUrlTicket('not-issued')).toBeNull()
    expect(consumeRemoteOpenUrlTicket({ requestId })).toBeNull()
    expect(consumeRemoteOpenUrlTicket(requestId, 1_000 + 120_000)).toBeNull()
  })

  it('records the callback from the URL main was given, not anything the renderer sends', () => {
    const { ticket } = issueRemoteOpenUrlTicket({
      url: authorize('http://localhost:1455/auth/callback'),
      sshTargetId: 't1'
    })
    expect(ticket.callback?.port).toBe(1455)
  })

  it('keeps a bounded number of pending tickets', () => {
    const first = issueRemoteOpenUrlTicket({ url: 'https://a.example/', sshTargetId: 't' })
    for (let i = 0; i < 64; i += 1) {
      issueRemoteOpenUrlTicket({ url: 'https://a.example/', sshTargetId: 't' })
    }
    expect(consumeRemoteOpenUrlTicket(first.requestId)).toBeNull()
  })
})
