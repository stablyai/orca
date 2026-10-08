import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const { waitForSentinel, request, dispose } = vi.hoisted(() => ({
  waitForSentinel: vi.fn(),
  request: vi.fn(),
  dispose: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ waitForSentinel }))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class {
    request = request
    dispose = dispose
  }
}))

import { countRelayEndpointPtys } from './ssh-relay-endpoint-pty-count'

const exec = vi.fn(async () => ({}))
// Only exec is read; the bridge transport itself is mocked above.
const conn: SshConnection = Object.assign(Object.create(null), { exec })
const SOCK = '/home/dev/.orca-remote/relay-1.4.0/relay-abc.sock'

describe('asking a relay how many PTYs it runs', () => {
  beforeEach(() => {
    exec.mockClear()
    waitForSentinel.mockReset().mockResolvedValue({})
    request.mockReset()
    dispose.mockReset()
  })

  it('lists through the relay’s own bridge without taking the owner role, then hangs up', async () => {
    request.mockResolvedValue([{ id: 'pty-1' }, { id: 'pty-2' }])

    await expect(countRelayEndpointPtys(conn, '/usr/bin/node', SOCK)).resolves.toBe(2)
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('relay.js --connect'), undefined)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'pty.listProcesses',
      { includeForegroundProcessEvidence: false },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(dispose).toHaveBeenCalled()
  })

  it.each([
    ['the bridge could not start', () => waitForSentinel.mockRejectedValue(new Error('exit 1'))],
    ['the request failed', () => request.mockRejectedValue(new Error('timeout'))],
    ['the answer is not a listing', () => request.mockResolvedValue({ nope: true })]
  ])('answers null when %s', async (_label, arrange) => {
    arrange()
    await expect(countRelayEndpointPtys(conn, '/usr/bin/node', SOCK)).resolves.toBeNull()
  })

  it('never guesses a relay whose socket was relocated outside its version directory', async () => {
    await expect(
      countRelayEndpointPtys(conn, '/usr/bin/node', '/tmp/.orca-relay-1000/relay-x/relay-abc.sock')
    ).resolves.toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })
})
