import { describe, expect, it, vi } from 'vitest'

type VerifyProc = (request: { hostname: string }, callback: (result: number) => void) => void

const mocks = vi.hoisted(() => {
  const sessions = new Map<string, { verifyProc: VerifyProc | null; fetch: unknown }>()
  return {
    sessions,
    fromPartition: (partition: string) => {
      let fake = sessions.get(partition)
      if (!fake) {
        const created: {
          verifyProc: VerifyProc | null
          fetch: unknown
          setCertificateVerifyProc(proc: VerifyProc): void
        } = {
          verifyProc: null,
          fetch: vi.fn(),
          setCertificateVerifyProc(proc: VerifyProc) {
            created.verifyProc = proc
          }
        }
        fake = created
        sessions.set(partition, created)
      }
      return fake
    },
    applyProxySettingsToSession: vi.fn(async () => ({ source: 'system' }))
  }
})

vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition } }))
vi.mock('../network/proxy-settings', () => ({
  applyProxySettingsToSession: mocks.applyProxySettingsToSession
}))

const { getInsecureTlsSession } = await import('./electron-youtrack-insecure-tls')

function verify(session: unknown, hostname: string): number {
  let result = Number.NaN
  const fake = [...mocks.sessions.values()].find((entry) => entry === session)
  fake?.verifyProc?.({ hostname }, (value) => {
    result = value
  })
  return result
}

describe('getInsecureTlsSession', () => {
  it('applies the current Orca proxy settings before every use', async () => {
    const first = await getInsecureTlsSession('yt.corp', { httpProxyUrl: 'http://proxy.corp:3128' })
    await getInsecureTlsSession('yt.corp', { httpProxyUrl: 'http://other:8080' })
    expect(mocks.applyProxySettingsToSession).toHaveBeenNthCalledWith(1, first, {
      httpProxyUrl: 'http://proxy.corp:3128'
    })
    expect(mocks.applyProxySettingsToSession).toHaveBeenNthCalledWith(2, first, {
      httpProxyUrl: 'http://other:8080'
    })
  })

  it('relaxes certificate checks for its own host only, even after another host connects', async () => {
    const first = await getInsecureTlsSession('YT.corp', {})
    const second = await getInsecureTlsSession('other.corp', {})
    expect(second).not.toBe(first)
    expect(verify(first, 'yt.corp')).toBe(0)
    expect(verify(first, 'other.corp')).toBe(-3)
    expect(verify(second, 'other.corp')).toBe(0)
    expect(verify(second, 'yt.corp')).toBe(-3)
  })
})
