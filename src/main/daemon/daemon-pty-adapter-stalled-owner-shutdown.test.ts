import { afterEach, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { PROTOCOL_VERSION } from './types'

const owner = {
  protocolVersion: PROTOCOL_VERSION,
  pid: 123,
  startedAtMs: 1000,
  launchNonce: 'reviewed-owner'
}
const reviewed = { owner, sessions: [] }

afterEach(() => vi.restoreAllMocks())

function fixture() {
  vi.spyOn(DaemonClient.prototype, 'getDaemonIdentity').mockReturnValue(owner)
  const request = vi.spyOn(DaemonClient.prototype, 'request')
  const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
  const exits = vi.spyOn(adapter, 'fanoutSyntheticExits')
  return { adapter, request, exits }
}

it('keeps automatic recovery closed after a lost shutdown reply without synthesizing successful exits', async () => {
  const { adapter, request, exits } = fixture()
  request.mockRejectedValue(new Error('Connection lost'))
  expect(await adapter.shutdownStalledOwner(reviewed)).toEqual({ status: 'refused' })
  expect(adapter['respawnAdoptionClosed']).toBe(true)
  expect(adapter.hasRetiredForIdle()).toBe(false)
  expect(exits).not.toHaveBeenCalled()
})

it('restores ordinary recovery when an older owner rejects the unknown RPC without shutting down', async () => {
  const { adapter, request, exits } = fixture()
  request.mockRejectedValue(new Error('Unknown request type: shutdownStalledOwner'))
  expect(await adapter.shutdownStalledOwner(reviewed)).toEqual({ status: 'refused' })
  expect(adapter['respawnAdoptionClosed']).toBe(false)
  expect(adapter.hasRetiredForIdle()).toBe(false)
  expect(exits).not.toHaveBeenCalled()
})

it('restores ordinary recovery after an explicit safe refusal', async () => {
  const { adapter, request, exits } = fixture()
  request.mockResolvedValue({ status: 'refused' })
  expect(await adapter.shutdownStalledOwner(reviewed)).toEqual({ status: 'refused' })
  expect(adapter['respawnAdoptionClosed']).toBe(false)
  expect(adapter.hasRetiredForIdle()).toBe(false)
  expect(exits).not.toHaveBeenCalled()
})

it('preserves an existing recovery fence when a second shutdown is refused', async () => {
  const { adapter, request } = fixture()
  request
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValueOnce({ status: 'refused' })
  await adapter.shutdownStalledOwner(reviewed)
  await adapter.shutdownStalledOwner(reviewed)
  expect(adapter['respawnAdoptionClosed']).toBe(true)
})
