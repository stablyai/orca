import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/nowhere' })
}))

import { sendPairedDesktopAccount } from './paired-desktop-account-declaration'

const sam = { id: 'acct-sam', name: 'Sam Lee', computer: "Sam's MacBook Pro" }

describe('declaring the paired desktop account', () => {
  it('resends the bare claim when an older host refuses its shape', async () => {
    const sent: unknown[] = []
    await sendPairedDesktopAccount(
      async (_method, params) => {
        sent.push(params)
        return sent.length === 1
          ? { id: '1', ok: false, error: { code: 'invalid_argument', message: 'Unrecognized key' } }
          : { id: '2', ok: true, result: {}, _meta: { runtimeId: 'r' } }
      },
      sam,
      'install-1'
    )
    expect(sent).toStrictEqual([
      { account: sam, clientInstanceId: 'install-1' },
      { account: { id: 'acct-sam', name: 'Sam Lee' } }
    ])
  })

  it('sends once when the host takes it', async () => {
    const sent: unknown[] = []
    await sendPairedDesktopAccount(
      async (_method, params) => {
        sent.push(params)
        return { id: '1', ok: true, result: {}, _meta: { runtimeId: 'r' } }
      },
      sam,
      'install-1'
    )
    expect(sent).toStrictEqual([{ account: sam, clientInstanceId: 'install-1' }])
  })
})
