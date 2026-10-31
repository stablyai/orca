import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { PROTOCOL_VERSION } from './types'

type ClientInternals = {
  client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
}

function createAdapter(
  protocolVersion: number,
  request: ReturnType<typeof vi.fn>
): DaemonPtyAdapter {
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/orca-steady-state-compat.sock',
    tokenPath: '/tmp/orca-steady-state-compat.token',
    protocolVersion
  })
  ;(adapter as unknown as ClientInternals).client = { request, disconnect: vi.fn() }
  return adapter
}

describe('foreground observations across retained daemon versions', () => {
  it.each([39, 43, 54])('does not request the new decision RPC from v%s', async (version) => {
    const request = vi.fn()
    const adapter = createAdapter(version, request)
    expect(adapter.supportsForegroundObservation('sess-a')).toBe(false)
    expect(request).not.toHaveBeenCalled()
    adapter.dispose()
  })
  it('adds only the requested field and accepts an omitted optional response', async () => {
    const answer = { foregroundProcess: 'claude', hasChildProcesses: true }
    const request = vi.fn(async () => answer)
    const adapter = createAdapter(PROTOCOL_VERSION, request)
    expect(adapter.supportsForegroundObservation('sess-a')).toBe(true)
    expect(
      await adapter.inspectProcess('sess-a', {
        foregroundOnly: true,
        expectedIncarnationId: 'inc-1'
      })
    ).toEqual(answer)
    expect(request).toHaveBeenCalledExactlyOnceWith('inspectProcess', {
      sessionId: 'sess-a',
      foregroundOnly: true,
      expectedIncarnationId: 'inc-1'
    })
    adapter.dispose()
  })
})
