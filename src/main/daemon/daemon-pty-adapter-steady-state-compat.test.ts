import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION, PROTOCOL_VERSION } from './types'

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

describe('steadyState across daemon versions', () => {
  it('sends steadyState as an additive optional field on the existing inspectProcess request', async () => {
    const request = vi.fn(async () => ({ foregroundProcess: 'claude', hasChildProcesses: true }))
    const adapter = createAdapter(PROTOCOL_VERSION, request)
    await adapter.inspectProcess('sess-a', { steadyState: true })
    expect(request).toHaveBeenCalledWith('inspectProcess', {
      sessionId: 'sess-a',
      steadyState: true
    })
    adapter.dispose()
  })

  it('omits the field entirely when not requested, so the wire is byte-identical to before', async () => {
    const request = vi.fn(async () => ({ foregroundProcess: null, hasChildProcesses: false }))
    const adapter = createAdapter(PROTOCOL_VERSION, request)
    await adapter.inspectProcess('sess-a', { expectedIncarnationId: 'inc-1', steadyState: false })
    expect(request).toHaveBeenCalledWith('inspectProcess', {
      sessionId: 'sess-a',
      expectedIncarnationId: 'inc-1'
    })
    adapter.dispose()
  })

  it('an old daemon that ignores steadyState still answers with the full-capture shape, and the client accepts it', async () => {
    // A pre-field daemon returns exactly what it always did: name + evidence, never a cheap answer.
    const oldDaemonAnswer = {
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      foregroundProcessEvidence: {
        verdict: 'live',
        processName: 'claude',
        authorityGeneration: 'gen',
        observationEpoch: 1,
        capturedAgeMs: 0,
        ptyId: 'sess-a',
        ptyIncarnationId: 'inc-1'
      }
    }
    const request = vi.fn(async () => oldDaemonAnswer)
    const adapter = createAdapter(COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION, request)
    await expect(adapter.inspectProcess('sess-a', { steadyState: true })).resolves.toEqual(
      oldDaemonAnswer
    )
    adapter.dispose()
  })

  it('a pre-inspection daemon never sees the field: the client composes from getForegroundProcess as before', async () => {
    const request = vi.fn(async () => ({ foregroundProcess: 'codex' }))
    const adapter = createAdapter(COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1, request)
    await expect(adapter.inspectProcess('sess-a', { steadyState: true })).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
    expect(request).toHaveBeenCalledWith('getForegroundProcess', { sessionId: 'sess-a' })
    adapter.dispose()
  })
})
