import { describe, expect, it, vi } from 'vitest'
import { probeTcpForwarding } from './ssh-tcp-forwarding-probe'

type OpenCallback = (error: (Error & { reason?: number }) | undefined, channel?: unknown) => void

function connectionAnswering(answer: (callback: OpenCallback) => void) {
  const forwardOut = vi.fn((_srcHost, _srcPort, _host, _port, callback: OpenCallback) =>
    answer(callback)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe calls only forwardOut on the client.
  return { forwardOut, connection: { getClient: () => ({ forwardOut }) as never } }
}

function openFailure(reason: number): Error & { reason: number } {
  return Object.assign(new Error('open failed'), { reason })
}

describe('TCP forwarding probe', () => {
  it('reads an administrative refusal as forwarding refused', async () => {
    const { connection } = connectionAnswering((callback) => callback(openFailure(1)))
    await expect(probeTcpForwarding(connection, 6768)).resolves.toBe('refused')
  })

  it('reads a connect failure as allowed: sshd tried, nothing listened yet', async () => {
    const { connection, forwardOut } = connectionAnswering((callback) => callback(openFailure(2)))
    await expect(probeTcpForwarding(connection, 6768)).resolves.toBe('allowed')
    expect(forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '127.0.0.1', 6768, expect.any(Function))
  })

  it('closes an opened channel and reads it as allowed', async () => {
    const channel = { close: vi.fn() }
    const { connection } = connectionAnswering((callback) => callback(undefined, channel))
    await expect(probeTcpForwarding(connection, 6768)).resolves.toBe('allowed')
    expect(channel.close).toHaveBeenCalled()
  })

  it('is unverifiable without an ssh2 client, on a throw, or with no answer', async () => {
    await expect(probeTcpForwarding({ getClient: () => null }, 6768)).resolves.toBe('unverifiable')
    const throwing = connectionAnswering(() => {
      throw new Error('Not connected')
    })
    await expect(probeTcpForwarding(throwing.connection, 6768)).resolves.toBe('unverifiable')
    const silent = connectionAnswering(() => {})
    await expect(probeTcpForwarding(silent.connection, 6768, 5)).resolves.toBe('unverifiable')
  })
})
