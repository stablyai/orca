import { describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { readTerminalSpawnAdmissionArg } from './terminal-spawn-gate'

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
  it('forwards a declared intent on create and omits it on attach-only', async () => {
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
      socketPath: '/tmp/orca-intent.sock',
      tokenPath: '/tmp/orca-intent.token'
    })
    try {
      await adapter.spawn({
        sessionId: 'intent',
        cols: 80,
        rows: 24,
        spawnIntent: 'automatic-restore'
      })
      await adapter.spawn({ sessionId: 'plain', cols: 80, rows: 24 })
      const [declared, undeclared] = createPayloads(requestSpy)
      expect(declared).toHaveProperty('spawnIntent', 'automatic-restore')
      expect(undeclared).not.toHaveProperty('spawnIntent')
    } finally {
      adapter.dispose()
      requestSpy.mockRestore()
      ensureConnectedSpy.mockRestore()
    }
  })

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

  it('passes a deferral back as-is instead of treating the daemon as gone', async () => {
    const ensureConnectedSpy = vi
      .spyOn(DaemonClient.prototype, 'ensureConnected')
      .mockResolvedValue()
    const requestSpy = vi
      .spyOn(DaemonClient.prototype, 'request')
      .mockRejectedValue(new Error('terminal_spawn_deferred:paused'))
    const adapter = new DaemonPtyAdapter({
      socketPath: '/tmp/orca-intent-deferred.sock',
      tokenPath: '/tmp/orca-intent-deferred.token'
    })
    try {
      await expect(
        adapter.spawn({
          sessionId: 'deferred',
          cols: 80,
          rows: 24,
          spawnIntent: 'automatic-restore'
        })
      ).rejects.toThrow('terminal_spawn_deferred:paused')
      expect(createPayloads(requestSpy)).toHaveLength(1)
    } finally {
      adapter.dispose()
      requestSpy.mockRestore()
      ensureConnectedSpy.mockRestore()
    }
  })

  it('reads the launcher flag and observes for anything else', () => {
    expect(readTerminalSpawnAdmissionArg(['node', 'entry', '--spawn-admission', 'enforce'])).toBe(
      'enforce'
    )
    expect(readTerminalSpawnAdmissionArg(['node', 'entry', '--spawn-admission', 'bogus'])).toBe(
      'observe'
    )
    expect(readTerminalSpawnAdmissionArg(['node', 'entry'])).toBe('observe')
  })
})
