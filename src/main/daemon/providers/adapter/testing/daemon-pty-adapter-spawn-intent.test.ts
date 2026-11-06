import { describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '../../../transport/client/daemon-client'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'

function createPayloads(requestSpy: { mock: { calls: unknown[][] } }): unknown[] {
  return requestSpy.mock.calls.filter(([type]) => type === 'createOrAttach').map(([, p]) => p)
}

const CLAIM = {
  claim: {
    digestVersion: 1 as const,
    keyId: 'key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'codex' as const
  },
  surface: {
    worktreeId: 'worktree',
    tabId: 'tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminalHandle: 'term_intent_claim'
  }
}

describe('daemon spawn intent wire', () => {
  it('never forwards interactive for a claimed resume, which an older daemon would not gate', async () => {
    const ensureConnectedSpy = vi
      .spyOn(DaemonClient.prototype, 'ensureConnected')
      .mockResolvedValue()
    const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
      isNew: true,
      pid: null,
      shellState: 'unsupported',
      snapshot: null
    })
    const adapter = new DaemonPtyAdapter({
      socketPath: '/tmp/orca-intent-claim.sock',
      tokenPath: '/tmp/orca-intent-claim.token'
    })
    try {
      await adapter
        .spawn({
          sessionId: 'claimed',
          cols: 80,
          rows: 24,
          spawnIntent: 'interactive',
          agentSessionEnsure: CLAIM
        })
        .catch(() => {})
      await adapter.spawn({ sessionId: 'shell', cols: 80, rows: 24, spawnIntent: 'interactive' })
      const [claimed, shell] = createPayloads(requestSpy)
      expect(claimed).toHaveProperty('spawnIntent', 'automatic-restore')
      expect(shell).toHaveProperty('spawnIntent', 'interactive')
    } finally {
      adapter.dispose()
      requestSpy.mockRestore()
      ensureConnectedSpy.mockRestore()
    }
  })
})
