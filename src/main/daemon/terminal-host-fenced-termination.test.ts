import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import type { PtyFencedTerminationRequest } from '../../shared/pty-fenced-termination'

const streamClient = () => ({ onData: vi.fn(), onExit: vi.fn() })
const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'a'.repeat(43),
  worktreeScopeDigest: 'b'.repeat(43),
  agent: 'codex' as const
}
const surface = {
  worktreeId: 'workspace',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: 'term_claimed'
}
let host: TerminalHost
let handles: ReturnType<typeof createMockSubprocess>[]
beforeEach(() => {
  handles = []
  host = new TerminalHost({
    spawnSubprocess: () => {
      const handle = createMockSubprocess()
      handles.push(handle)
      return handle
    }
  })
})
afterEach(async () => {
  for (const handle of handles) {
    handle._simulateExit(0)
  }
  await host.dispose()
})
async function create(id = 'pty', claimed = false) {
  return host.createOrAttach({
    sessionId: id,
    cols: 80,
    rows: 24,
    streamClient: streamClient(),
    ...(claimed ? { agentSessionEnsure: { claim, surface } } : {})
  })
}
function request(
  incarnationId: string,
  overrides: Partial<PtyFencedTerminationRequest> = {}
): PtyFencedTerminationRequest {
  return {
    id: 'pty',
    expectedIncarnationId: incarnationId,
    requireNoAgentOwner: true,
    requireUnattached: true,
    ...overrides
  }
}

describe('execution-side conditional teardown', () => {
  it('refuses a same-ID replacement before touching the replacement process or attachments', async () => {
    const original = await create()
    handles[0]!._simulateExit(0)
    const replacement = await create()
    expect(replacement.incarnationId).not.toBe(original.incarnationId)
    expect(host.beginFencedTermination(request(original.incarnationId))).toEqual({
      accepted: false,
      result: { outcome: 'refused', reason: 'replaced' }
    })
    expect(handles[1]!.forceKill).not.toHaveBeenCalled()
    expect(host.listSessions()).toMatchObject([
      { incarnationId: replacement.incarnationId, state: 'running' }
    ])
  })

  it('refuses a client attach after the listing', async () => {
    const created = await create()
    expect(host.beginFencedTermination(request(created.incarnationId))).toEqual({
      accepted: false,
      result: { outcome: 'refused', reason: 'attached' }
    })
    expect(handles[0]!.forceKill).not.toHaveBeenCalled()
  })

  it('refuses a promoted agent claim after the listing', async () => {
    const created = await create('pty', true)
    host.detach('pty', created.attachToken)
    expect(host.beginFencedTermination(request(created.incarnationId))).toEqual({
      accepted: false,
      result: { outcome: 'refused', reason: 'claimed' }
    })
    expect(handles[0]!.forceKill).not.toHaveBeenCalled()
  })

  it('refuses an in-flight claim before its promotion', async () => {
    const created = await create()
    host.detach('pty', created.attachToken)
    const claiming = host.createOrAttach({
      sessionId: 'pty',
      cols: 80,
      rows: 24,
      streamClient: streamClient(),
      agentSessionEnsure: { claim, surface }
    })
    expect(host.beginFencedTermination(request(created.incarnationId))).toEqual({
      accepted: false,
      result: { outcome: 'refused', reason: 'claimed' }
    })
    await expect(claiming).rejects.toThrow('agent_session_claim_unavailable')
    expect(handles[0]!.forceKill).not.toHaveBeenCalled()
  })

  it('reserves teardown synchronously, refuses later attach, and waits for physical exit', async () => {
    const created = await create()
    host.detach('pty', created.attachToken)
    vi.mocked(handles[0]!.forceKill).mockImplementation(() => {})
    const termination = host.beginFencedTermination(request(created.incarnationId))
    expect(termination.accepted).toBe(true)
    if (!termination.accepted) {
      throw new Error('Expected acceptance')
    }
    expect(host.listSessions()).toMatchObject([{ state: 'exiting' }])
    await expect(
      host.createOrAttach({
        sessionId: 'pty',
        cols: 80,
        rows: 24,
        streamClient: streamClient(),
        attachOnly: true
      })
    ).rejects.toThrow('Session not found')
    let settled = false
    void termination.completion.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    handles[0]!._simulateExit(0)
    await expect(termination.completion).resolves.toEqual({ outcome: 'ended' })
    expect(host.listSessions()).toEqual([])
  })

  it('answers already_exited without disturbing an absent incarnation', async () => {
    const created = await create()
    handles[0]!._simulateExit(0)
    expect(host.beginFencedTermination(request(created.incarnationId))).toEqual({
      accepted: false,
      result: { outcome: 'already_exited' }
    })
  })

  it('does not join another incarnation’s already-running teardown', async () => {
    const created = await create()
    const kill = host.kill('pty', { immediate: true })
    const result = host.beginFencedTermination(
      request('old-incarnation', { requireUnattached: false })
    )
    expect(result).toEqual({ accepted: false, result: { outcome: 'refused', reason: 'replaced' } })
    handles[0]!._simulateExit(0)
    await kill
    expect(created.incarnationId).toBeTruthy()
  })
})
