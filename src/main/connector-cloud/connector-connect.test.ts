import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as LoopbackCallback from '../orca-profiles/cloud-auth/loopback-callback'

const mocks = vi.hoisted(() => ({ refuseListen: false }))
vi.mock('../orca-profiles/cloud-auth/loopback-callback', async (importOriginal) => {
  const actual = await importOriginal<typeof LoopbackCallback>()
  return {
    serveLoopbackCallback: (options: Parameters<typeof actual.serveLoopbackCallback>[0]) =>
      mocks.refuseListen
        ? Promise.reject(new Error('listen EACCES'))
        : actual.serveLoopbackCallback(options)
  }
})

import {
  cancelConnectorConnect,
  connectConnector,
  redeemConnectorFallback
} from './connector-connect'

const RESULT = 'r'.repeat(43)
const linked = {
  identity: { userId: 'L-me', name: 'Dana', handle: 'dana' },
  workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  install: 'installed' as const
}

type Started = { port: number; nonce: string } | null

function fakeClient(options: { startError?: string; holdStart?: Promise<void> } = {}) {
  const starts: Started[] = []
  let opened: (loopback: Started) => void = () => {}
  const started = new Promise<Started>((resolve) => {
    opened = resolve
  })
  const client = {
    startConnect: vi.fn(
      async (
        _source: string,
        start: { loopback: Started; switchAccount: boolean; loginKey?: string }
      ) => {
        starts.push(start.loopback)
        await options.holdStart
        return options.startError
          ? ({ ok: false, error: options.startError } as const)
          : ({ ok: true, value: { authorizeUrl: 'https://connector.example/authorize' } } as const)
      }
    ),
    redeemConnect: vi.fn(async () => ({ ok: true, value: linked }) as const)
  }
  const openExternal = vi.fn(async () => opened(starts.at(-1) ?? null))
  return { client, openExternal, starts, started }
}

afterEach(() => {
  vi.useRealTimers()
  mocks.refuseListen = false
  cancelConnectorConnect('linear')
  cancelConnectorConnect('github')
})

describe('connectConnector', () => {
  it('listens on 127.0.0.1, ignores stray hits, and redeems the result this trip’s nonce brings', async () => {
    const { client, openExternal, started } = fakeClient()
    const trip = connectConnector('linear', client, { switchAccount: false, openExternal })
    const loopback = await started
    expect(loopback?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const base = `http://127.0.0.1:${loopback?.port}`

    // Probes and another trip's tab leave the trip waiting.
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
    expect((await fetch(`${base}/connector/done?r=${RESULT}&n=${'x'.repeat(43)}`)).status).toBe(400)
    expect((await fetch(`${base}/connector/done?n=${loopback?.nonce}`)).status).toBe(400)

    const page = await fetch(`${base}/connector/done?r=${RESULT}&n=${loopback?.nonce}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Signed in to Linear')
    expect(await trip).toEqual({ ok: true, value: linked })
    expect(client.redeemConnect).toHaveBeenCalledWith('linear', RESULT)
    expect(client.startConnect).toHaveBeenCalledWith('linear', {
      loopback,
      switchAccount: false
    })
    // One valid hit closes the listener.
    await expect(fetch(`${base}/connector/done?r=${RESULT}&n=${loopback?.nonce}`)).rejects.toThrow()
  })

  it('reports the cloud’s refusal to start, and opens no browser', async () => {
    const { client, openExternal } = fakeClient({ startError: 'signed_out' })
    expect(
      await connectConnector('github', client, { switchAccount: false, openExternal })
    ).toEqual({ ok: false, error: 'signed_out' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('ends as cancelled when cancelled, or when a newer trip starts', async () => {
    const first = fakeClient()
    const trip = connectConnector('github', first.client, {
      switchAccount: false,
      openExternal: first.openExternal
    })
    await first.started
    const second = fakeClient()
    const next = connectConnector('github', second.client, {
      switchAccount: true,
      openExternal: second.openExternal
    })
    expect(await trip).toEqual({ ok: false, error: 'cancelled' })
    await second.started
    cancelConnectorConnect('github')
    expect(await next).toEqual({ ok: false, error: 'cancelled' })
    expect(second.client.redeemConnect).not.toHaveBeenCalled()
  })

  it('opens no browser for a trip cancelled while the cloud was starting it', async () => {
    let answer: () => void = () => {}
    const holdStart = new Promise<void>((resolve) => (answer = resolve))
    const { client, openExternal } = fakeClient({ holdStart })
    const trip = connectConnector('linear', client, { switchAccount: false, openExternal })
    await vi.waitFor(() => expect(client.startConnect).toHaveBeenCalled())
    cancelConnectorConnect('linear')
    answer()
    expect(await trip).toEqual({ ok: false, error: 'cancelled' })
    // The trip's own await on the cloud's answer runs first, so the browser would have opened by now.
    await client.startConnect.mock.results[0]?.value
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('without a loopback port, starts a trip that ends at "Open Orca" instead', async () => {
    mocks.refuseListen = true
    const { client, openExternal, starts } = fakeClient()
    expect(
      await connectConnector('linear', client, { switchAccount: false, openExternal })
    ).toEqual({ ok: true, value: null })
    expect(starts).toEqual([null])
    expect(openExternal).toHaveBeenCalledWith('https://connector.example/authorize')
  })
})

describe('redeemConnectorFallback', () => {
  async function fallbackTrip() {
    mocks.refuseListen = true
    const fake = fakeClient()
    expect(
      await connectConnector('linear', fake.client, {
        switchAccount: false,
        openExternal: fake.openExternal
      })
    ).toEqual({ ok: true, value: null })
    return fake
  }

  it('redeems the "Open Orca" link of a trip that fell back, once', async () => {
    const { client } = await fallbackTrip()
    expect(await redeemConnectorFallback('linear', client, RESULT)).toEqual({
      ok: true,
      value: linked
    })
    expect(await redeemConnectorFallback('linear', client, RESULT)).toEqual({
      ok: false,
      error: 'expired'
    })
    expect(client.redeemConnect).toHaveBeenCalledTimes(1)
  })

  it('refuses a link when no trip fell back, or for the other source', async () => {
    const { client } = fakeClient()
    expect(await redeemConnectorFallback('linear', client, RESULT)).toEqual({
      ok: false,
      error: 'expired'
    })
    const fellBack = await fallbackTrip()
    expect(await redeemConnectorFallback('github', fellBack.client, RESULT)).toEqual({
      ok: false,
      error: 'expired'
    })
    expect(client.redeemConnect).not.toHaveBeenCalled()
    expect(fellBack.client.redeemConnect).not.toHaveBeenCalled()
  })

  it('refuses a link after Cancel, a newer trip, or 10 minutes', async () => {
    const cancelled = await fallbackTrip()
    cancelConnectorConnect('linear')
    expect(await redeemConnectorFallback('linear', cancelled.client, RESULT)).toEqual({
      ok: false,
      error: 'expired'
    })

    const replaced = await fallbackTrip()
    mocks.refuseListen = false
    const next = fakeClient()
    void connectConnector('linear', next.client, {
      switchAccount: false,
      openExternal: next.openExternal
    })
    await next.started
    expect(await redeemConnectorFallback('linear', replaced.client, RESULT)).toEqual({
      ok: false,
      error: 'expired'
    })
    cancelConnectorConnect('linear')

    vi.useFakeTimers({ toFake: ['Date'] })
    const stale = await fallbackTrip()
    vi.setSystemTime(Date.now() + 10 * 60_000)
    expect(await redeemConnectorFallback('linear', stale.client, RESULT)).toEqual({
      ok: false,
      error: 'expired'
    })
    for (const trip of [cancelled, replaced, stale]) {
      expect(trip.client.redeemConnect).not.toHaveBeenCalled()
    }
  })
})

describe('the login a Linear trip hands this computer', () => {
  const login = {
    accessToken: 'lin_oauth_access',
    refreshToken: 'lin_refresh',
    expiresAt: 1_800_000_000_000,
    clientId: 'client-1'
  }
  // The cloud seals to whatever key the start sent.
  const sealingClient = (sealFor: (loginKey: string) => string) => {
    const fake = fakeClient()
    let loginKey = ''
    fake.client.startConnect.mockImplementation(async (_source, start) => {
      fake.starts.push(start.loopback)
      loginKey = start.loginKey ?? ''
      return { ok: true, value: { authorizeUrl: 'https://connector.example/authorize' } } as const
    })
    fake.client.redeemConnect.mockImplementation(
      async () => ({ ok: true, value: { ...linked, sealedLogin: sealFor(loginKey) } }) as const
    )
    return fake
  }

  it('reports the link only after the kept login is saved', async () => {
    const { sealConnectLogin } =
      await import('../../../cloud/packages/connector-contract/src/connect-login-seal')
    const { client, openExternal, started } = sealingClient((key) => sealConnectLogin(key, login))
    let finishSave = (): void => {}
    const keepLogin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        })
    )
    const trip = connectConnector('linear', client, {
      switchAccount: false,
      openExternal,
      keepLogin
    })
    let reported = false
    void trip.then(() => {
      reported = true
    })
    const loopback = await started
    await fetch(
      `http://127.0.0.1:${loopback?.port}/connector/done?r=${RESULT}&n=${loopback?.nonce}`
    )
    await vi.waitFor(() => expect(keepLogin).toHaveBeenCalledWith(login, linked))
    await new Promise((resolve) => setImmediate(resolve))
    expect(reported).toBe(false)
    finishSave()
    expect(await trip).toEqual({ ok: true, value: linked })
  })

  it('keeps nothing it can’t open, and never asks without a keeper', async () => {
    const { sealConnectLogin, createConnectLoginKey } =
      await import('../../../cloud/packages/connector-contract/src/connect-login-seal')
    const other = createConnectLoginKey().publicKey
    const { client, openExternal, started } = sealingClient(() => sealConnectLogin(other, login))
    const keepLogin = vi.fn()
    const trip = connectConnector('linear', client, {
      switchAccount: false,
      openExternal,
      keepLogin
    })
    const loopback = await started
    await fetch(
      `http://127.0.0.1:${loopback?.port}/connector/done?r=${RESULT}&n=${loopback?.nonce}`
    )
    expect(await trip).toEqual({ ok: true, value: linked })
    expect(keepLogin).not.toHaveBeenCalled()

    const plain = fakeClient()
    const plainTrip = connectConnector('github', plain.client, {
      switchAccount: false,
      openExternal: plain.openExternal
    })
    await plain.started
    expect(plain.client.startConnect.mock.calls[0]?.[1]).not.toHaveProperty('loginKey')
    cancelConnectorConnect('github')
    await plainTrip
  })
})
