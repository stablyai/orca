import { beforeEach, expect, it, vi } from 'vitest'
import { verifyRemoteOrcadCanceledStopReceipt } from './orcad-canceled-stop-receipt-store'
import { getRemoteHostPlatform } from './ssh-remote-platform'
const read = vi.hoisted(() => vi.fn())
vi.mock('./orcad-remote-record-file', () => ({ readBoundedOrcadRemoteRecord: read }))
beforeEach(() => vi.resetAllMocks())
const request = {
  schemaVersion: 1 as const,
  version: '0.1.0+test',
  authority: {
    runtimeId: 'runtime',
    profileId: 'profile',
    profileRoot: '/profile',
    transactionId: '11111111-1111-4111-8111-111111111111'
  },
  instance: { pid: 123, startedAtMs: null, nonce: 'original', lockPath: '/host/lock' }
}
const receipt = { schemaVersion: 1, kind: 'orcad_managed_stop_canceled', request }

it.each(['linux-x64', 'win32-x64'] as const)(
  'reads exact bounded host evidence using %s paths',
  async (platform) => {
    const options = {
      conn: {} as never,
      host: getRemoteHostPlatform(platform),
      remoteHome: platform === 'win32-x64' ? 'C:\\Users\\Host' : '/home/host'
    }
    read.mockResolvedValue(JSON.stringify(receipt))
    await expect(verifyRemoteOrcadCanceledStopReceipt(options, request)).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledWith(
      options,
      platform === 'win32-x64'
        ? `C:/Users/Host/.orca-remote/orcad-canceled-stops/${request.authority.transactionId}.json`
        : `/home/host/.orca-remote/orcad-canceled-stops/${request.authority.transactionId}.json`,
      65536
    )
  }
)

it.each([
  '',
  '{',
  JSON.stringify({ ...receipt, request: { ...request, version: 'other' } }),
  JSON.stringify({
    ...receipt,
    request: { ...request, instance: { ...request.instance, nonce: 'replacement' } }
  })
])('refuses absent, malformed or mismatched evidence (%#)', async (raw) => {
  read.mockResolvedValue(raw)
  await expect(
    verifyRemoteOrcadCanceledStopReceipt(
      { conn: {} as never, host: getRemoteHostPlatform('linux-x64'), remoteHome: '/home/host' },
      request
    )
  ).rejects.toThrow()
})
