import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agent: 'claude' as const
}
const surface = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: 'term_restored'
}

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
afterEach(async () => {
  if (harness) {
    await harness.adapter.disconnectOnly()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    harness = undefined
  }
})

describe('daemon conversation-claim release', () => {
  it('an older daemon is never asked and never reports a release', async () => {
    const adapter = new DaemonPtyAdapter({
      socketPath: '/unused',
      tokenPath: '/unused',
      protocolVersion: 54
    })
    const request = vi.spyOn(adapter['client'], 'request')
    expect(adapter.supportsAgentSessionClaimRelease('pty')).toBe(false)
    const owner = { claim, generation: 'g', phase: 'live' as const, ptyId: 'pty', surface }
    await expect(
      adapter.releaseAgentSessionClaim({ id: 'pty', expectedIncarnationId: 'A', owner }, 1_000)
    ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
    expect(request).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('removes only the exact binding over a real control connection and keeps the terminal', async () => {
    const handles: ReturnType<typeof createMockSubprocess>[] = []
    harness = await startDaemonAdapterHarness(() => {
      handles.push(createMockSubprocess())
      return handles.at(-1)!
    })
    const adapter = harness.adapter
    const created = await adapter.spawn({
      sessionId: 'restored-pane',
      cols: 80,
      rows: 24,
      agentSessionEnsure: { claim, surface }
    })
    const owner = created.agentSessionEnsure!.owner
    const incarnationId = created.incarnationId!
    const release = (request: Partial<Parameters<typeof adapter.releaseAgentSessionClaim>[0]>) =>
      adapter.releaseAgentSessionClaim(
        { id: 'restored-pane', expectedIncarnationId: incarnationId, owner, ...request },
        5_000
      )

    await expect(release({ expectedIncarnationId: 'old-incarnation' })).resolves.toEqual({
      outcome: 'refused',
      reason: 'replaced'
    })
    await expect(release({ owner: { ...owner, generation: 'other-generation' } })).resolves.toEqual(
      { outcome: 'refused', reason: 'owner' }
    )
    expect((await adapter.listProcesses())[0]?.agentSessionOwners).toHaveLength(1)

    await expect(release({})).resolves.toEqual({ outcome: 'released' })
    // Same live incarnation and nothing pending: a repeated request is acknowledged, not re-adopted.
    await expect(release({})).resolves.toEqual({ outcome: 'released' })
    const [listed] = await adapter.listProcesses()
    expect(listed).toMatchObject({ id: 'restored-pane', incarnationId })
    expect(listed?.agentSessionOwners ?? []).toEqual([])
    expect(handles[0]?.forceKill).not.toHaveBeenCalled()

    // A later explicit resume of the same conversation gets its own terminal, never this one.
    const later = await adapter.spawn({
      sessionId: 'history-resume',
      cols: 80,
      rows: 24,
      agentSessionEnsure: { claim, surface: { ...surface, terminalHandle: 'term_history' } }
    })
    expect(later.id).toBe('history-resume')
    expect(later.agentSessionEnsure).toMatchObject({
      disposition: 'created',
      owner: { ptyId: 'history-resume' }
    })
  })
})
