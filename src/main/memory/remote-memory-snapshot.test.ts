import { describe, expect, it } from 'vitest'
import { parseRemoteMemorySnapshot } from './remote-memory-snapshot'

const minimal = { worktrees: [] }

describe('parseRemoteMemorySnapshot', () => {
  it('rejects a payload that is not a snapshot', () => {
    expect(parseRemoteMemorySnapshot(null)).toBeNull()
    expect(parseRemoteMemorySnapshot('nope')).toBeNull()
    expect(parseRemoteMemorySnapshot({})).toBeNull()
    expect(parseRemoteMemorySnapshot({ worktrees: 'no' })).toBeNull()
  })

  it('accepts a bare snapshot from a host that omits optional sections', () => {
    const snapshot = parseRemoteMemorySnapshot(minimal)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.worktrees).toEqual([])
    expect(snapshot?.app.memory).toBe(0)
    // Why: a headless host reports no pressure source; don't claim one it never sent.
    expect(snapshot?.host.availableMemorySource).toBe('free-memory')
    expect(snapshot?.processMemoryMetric).toBe('rss')
  })

  it('carries through a full payload', () => {
    const snapshot = parseRemoteMemorySnapshot({
      app: { cpu: 2, memory: 100, main: { cpu: 1, memory: 60 }, history: [100] },
      worktrees: [
        {
          worktreeId: 'repo::/srv/api',
          worktreeName: 'api',
          repoId: 'repo',
          repoName: 'API',
          cpu: 12,
          memory: 900,
          history: [900],
          sessions: [{ sessionId: 'pty-1', paneKey: 'pane', pid: 44, cpu: 12, memory: 900 }]
        }
      ],
      host: { totalMemory: 16, availableMemorySource: 'proc-meminfo', cpuCoreCount: 8 },
      processMemoryMetric: 'working-set',
      totalCpu: 12,
      totalMemory: 1000,
      collectedAt: 123
    })
    expect(snapshot?.processMemoryMetric).toBe('working-set')
    expect(snapshot?.host.availableMemorySource).toBe('proc-meminfo')
    expect(snapshot?.worktrees[0].sessions[0]).toEqual({
      sessionId: 'pty-1',
      paneKey: 'pane',
      pid: 44,
      cpu: 12,
      memory: 900
    })
    expect(snapshot?.collectedAt).toBe(123)
  })

  it('drops malformed rows instead of failing the whole snapshot', () => {
    const snapshot = parseRemoteMemorySnapshot({
      worktrees: [
        { worktreeId: '', repoId: 'repo' },
        null,
        {
          worktreeId: 'repo::/srv/api',
          sessions: [{ pid: 1 }, { sessionId: 'pty-2', cpu: 'lots', memory: -5 }]
        }
      ]
    })
    expect(snapshot?.worktrees).toHaveLength(1)
    const sessions = snapshot?.worktrees[0].sessions ?? []
    expect(sessions).toHaveLength(1)
    // Why: a non-numeric or negative reading is unknown, and unknown reads as 0 here
    // rather than as a NaN that would poison every downstream total.
    expect(sessions[0]).toMatchObject({ sessionId: 'pty-2', cpu: 0, memory: 0 })
  })

  it('carries a host-reported session title through', () => {
    const snapshot = parseRemoteMemorySnapshot({
      worktrees: [
        {
          worktreeId: 'repo::/srv/api',
          sessions: [
            { sessionId: 'pty-1', title: '  build watch  ' },
            { sessionId: 'pty-2', title: '   ' },
            { sessionId: 'pty-3' }
          ]
        }
      ]
    })
    const sessions = snapshot?.worktrees[0].sessions ?? []
    expect(sessions[0].title).toBe('build watch')
    // Why: a blank title is no title — it must not shadow the pid fallback.
    expect(sessions[1].title).toBeUndefined()
    expect(sessions[2].title).toBeUndefined()
  })

  it('ignores unknown fields a newer host may add', () => {
    const snapshot = parseRemoteMemorySnapshot({
      ...minimal,
      somethingNew: { nested: true },
      totalMemory: 42
    })
    expect(snapshot?.totalMemory).toBe(42)
  })
})
