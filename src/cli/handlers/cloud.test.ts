import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { CLOUD_HANDLERS, formatCloudStatus, formatSignInPrompt } from './cloud'

function contextWith(
  call: (method: string, params: unknown) => unknown,
  flags: [string, string | boolean][] = [],
  json = false
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only flags, json and client.call.
  return {
    flags: new Map(flags),
    json,
    client: {
      call: vi.fn(async (method: string, params: unknown) => ({
        result: await call(method, params)
      }))
    }
  } as unknown as HandlerContext
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('orca cloud', () => {
  it('prints the link and code, then waits on the host until approved', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'], now: 1_800_000_000_000 })
    const expiresAt = 1_800_000_000_000 + 10 * 60_000
    const context = contextWith(
      (method) =>
        method === 'cloud.beginSignIn'
          ? {
              flowId: 'flow-1',
              userCode: 'ABCD-EFGH',
              verificationUri: 'https://c.test/host-login',
              expiresAt
            }
          : { hostId: 'h', email: 'ada@example.com', hostName: 'box', linkedAt: 1 },
      [['name', 'box']]
    )

    await CLOUD_HANDLERS['cloud login'](context)

    expect(context.client.call).toHaveBeenNthCalledWith(
      1,
      'cloud.beginSignIn',
      { name: 'box' },
      undefined
    )
    expect(context.client.call).toHaveBeenNthCalledWith(
      2,
      'cloud.finishSignIn',
      { flowId: 'flow-1' },
      { timeoutMs: expect.any(Number) }
    )
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'To connect this Orca, open https://c.test/host-login and enter ABCD-EFGH (expires in 10 minutes)',
      'Connected as ada@example.com on box'
    ])
  })

  it('names connectors being off and refuses remote targeting', async () => {
    const off = contextWith(() => {
      throw new RuntimeClientError('connectors_disabled', 'connectors_disabled')
    })
    await expect(CLOUD_HANDLERS['cloud login'](off)).rejects.toThrow(
      'Connectors are off on this Orca.'
    )

    const remote = contextWith(() => ({}), [['environment', 'prod']])
    await expect(CLOUD_HANDLERS['cloud status'](remote)).rejects.toThrow('does not retarget')
    expect(remote.client.call).not.toHaveBeenCalled()
  })

  it('formats status', () => {
    expect(formatCloudStatus({ enabled: false, link: null })).toBe(
      'Signed out\nConnectors are off on this Orca.'
    )
    expect(
      formatCloudStatus({
        enabled: true,
        link: { hostId: 'h', email: 'ada@example.com', hostName: 'box', linkedAt: 1 }
      })
    ).toBe('Connected as ada@example.com on box')
    expect(
      formatSignInPrompt(
        { flowId: 'f', userCode: 'C', verificationUri: 'https://u', expiresAt: 30_000 },
        0
      )
    ).toContain('(expires in 1 minutes)')
  })
})
