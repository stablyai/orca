import { beforeEach, expect, it, vi } from 'vitest'
import { registerRelayPtySourceCredit } from './relay-pty-source-credit-registration'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  installSshPtySourceAckPublisher,
  installSshPtySourceCancellationPublisher
} from '../ipc/ssh-pty-output-intake-registry'
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  installSshPtySourceAckPublisher: vi.fn(),
  installSshPtySourceCancellationPublisher: vi.fn()
}))
const releaseAck = vi.fn()
const releaseCancellation = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(installSshPtySourceAckPublisher).mockReturnValue(releaseAck)
  vi.mocked(installSshPtySourceCancellationPublisher).mockReturnValue(releaseCancellation)
})
function fixture() {
  const mux = new SshChannelMultiplexer({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn()
  })
  const request = vi
    .spyOn(mux, 'request')
    .mockResolvedValue({ canceled: true, sentEndSu: 10, creditedEndSu: 5 })
  const registration = registerRelayPtySourceCredit(mux, 9, (id) => id.slice('wsl:'.length))
  const publish = vi.mocked(installSshPtySourceCancellationPublisher).mock.calls[0][1]
  return { mux, request, registration, publish }
}
it('maps owner-specific cancellation IDs without an SSH identity', async () => {
  const { mux, request, registration, publish } = fixture()
  expect(
    await publish({
      id: 'wsl:pty2:owner:1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token'
    })
  ).toEqual({ sentEndSu: 10, creditedEndSu: 5 })
  expect(request).toHaveBeenCalledWith(
    'pty.cancelDelivery',
    expect.objectContaining({ id: 'pty2:owner:1' })
  )
  registration.releaseAck()
  registration.releaseCancellation()
  expect(releaseAck).toHaveBeenCalledOnce()
  expect(releaseCancellation).toHaveBeenCalledOnce()
  mux.dispose()
})
it.each([
  null,
  { canceled: false },
  { canceled: true, sentEndSu: 4, creditedEndSu: 5 },
  { canceled: true, sentEndSu: -1, creditedEndSu: 0 }
])('rejects invalid cancellation proof %j', async (result) => {
  const { mux, request, publish } = fixture()
  request.mockResolvedValue(result)
  await expect(
    publish({ id: 'wsl:pty', clientGeneration: 2, ownerGeneration: 3, deliveryToken: 'token' })
  ).rejects.toThrow('proof_invalid')
  mux.dispose()
})
it('releases the first registration if the second fails', () => {
  vi.mocked(installSshPtySourceCancellationPublisher).mockImplementation(() => {
    throw new Error('duplicate')
  })
  expect(fixture).toThrow('duplicate')
  expect(releaseAck).toHaveBeenCalledOnce()
})
