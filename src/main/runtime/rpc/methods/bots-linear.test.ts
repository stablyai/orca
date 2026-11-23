import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

const mocks = vi.hoisted(() => ({
  unlink: vi.fn(),
  cleared: new Array<string>()
}))
vi.mock('../../../connector-cloud/bots-cloud-client', () => ({
  withBotsCloudClient: (_cloud: unknown, run: (client: unknown) => unknown) =>
    run({ unlinkLinear: mocks.unlink })
}))
vi.mock('../../../linear/accounts/linear-login-store', () => ({
  clearWorkspaceLogin: (workspaceId: string) => mocks.cleared.push(workspaceId),
  keepConnectedLinearLogin: vi.fn()
}))

import { BOT_LINEAR_METHODS } from './bots-linear'

const unlink = (workspaceId: string) =>
  Promise.resolve(
    BOT_LINEAR_METHODS.find((method) => method.name === 'bots.linear.unlink')?.handler(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the unlink handler reads only workspaceId and the runtime's cloud, both given here.
      { workspaceId } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      { runtime: { getConnectorCloud: () => null } } as unknown as RpcContext
    )
  )

beforeEach(() => {
  mocks.unlink.mockReset()
  mocks.cleared.length = 0
})

describe('bots.linear.unlink', () => {
  it('forgets the workspace’s Linear login once the cloud unlinked it', async () => {
    mocks.unlink.mockResolvedValueOnce({ ok: true, value: undefined })
    await unlink('org-1')
    expect(mocks.cleared).toEqual(['org-1'])
  })

  it('keeps the login when the unlink failed', async () => {
    mocks.unlink.mockResolvedValueOnce({ ok: false, error: 'signed_out' })
    expect(await unlink('org-1')).toEqual({ ok: false, error: 'signed_out' })
    expect(mocks.cleared).toEqual([])
  })
})
