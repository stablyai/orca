/**
 * The chat tab must survive a close that did not land.
 *
 * `closeStructuredAgentSessionChild` hides the tab BEFORE it issues the close, so every failure
 * shape past that point used to leave the user's chat tab pulled out of the durable restore index
 * for a session that is still running — a destructive operation that refused, and still took
 * something away.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { closeStructuredAgentSessionChild } = await import('./structured-agent-session-close')

const SESSION = 'session-1'

function record(sessionId: string): AgentSessionRecord {
  return {
    sessionId,
    provider: 'claude',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'repo_1::/tmp/wt-a',
      workspaceKind: 'folder'
    },
    lease: {
      sessionId,
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 1,
      deathEvidence: null
    }
  } as unknown as AgentSessionRecord
}

type HostOptions = {
  /** Sessions the host keeps holding through a close, so the post-close observation is `live`. */
  stuck?: boolean
  /** Rejects the close, without the child going. */
  closeThrows?: Error
  /** The child dies and is recorded dead, but the close then fails past that proof. */
  settledThenThrows?: boolean
  /** Rejects the visibility write itself, so the hide never lands. */
  visibilityThrows?: Error
  /** Sessions already in the persisted visible-tab index. */
  visible?: string[]
  /** Blows up the index read, so the rollback cannot prove the tab was ever visible. */
  indexThrows?: boolean
}

function installHost(options: HostOptions = {}) {
  const entry = record(SESSION)
  const held = new Set([SESSION])
  const visible = new Set(options.visible ?? [SESSION])
  const setSessionTabVisibility = vi.fn(async (sessionId: string, isVisible: boolean) => {
    if (options.visibilityThrows) {
      throw options.visibilityThrows
    }
    if (isVisible) {
      visible.add(sessionId)
    } else {
      visible.delete(sessionId)
    }
  })
  const close = vi.fn(async (sessionId: string) => {
    if (options.closeThrows) {
      throw options.closeThrows
    }
    if (options.stuck) {
      return
    }
    held.delete(sessionId)
    entry.lease.claimStatus = 'released'
    entry.lease.deathEvidence = { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
    if (options.settledThenThrows) {
      throw new Error('the event sink could not be flushed')
    }
  })
  hostRef.current = {
    deps: { store: { getRecord: (id: string) => (id === SESSION ? entry : null) } },
    hasSession: (sessionId: string) => held.has(sessionId),
    getPersistedVisibleSessionTabIndex: () => {
      if (options.indexThrows) {
        throw new Error('visible tab index unreadable')
      }
      return { present: true, sessionIds: [...visible] }
    },
    setSessionTabVisibility,
    close
  }
  return { close, setSessionTabVisibility, visible }
}

describe('closeStructuredAgentSessionChild tab-visibility rollback', () => {
  beforeEach(() => {
    hostRef.current = null
    vi.restoreAllMocks()
  })

  it('retires the tab and reports the close on the success path', async () => {
    const host = installHost()
    const retire = vi.fn(() => true)

    const outcome = await closeStructuredAgentSessionChild(SESSION, {
      runtime: {
        retireStructuredAgentSessionTabFromSnapshot: retire
      } as never
    })

    expect(outcome).toEqual({ stopped: true, closeAttempted: true })
    expect(host.visible.has(SESSION)).toBe(false)
    expect(retire).toHaveBeenCalledWith(SESSION)
    // The hide is the only visibility write a settled close performs.
    expect(host.setSessionTabVisibility.mock.calls).toEqual([[SESSION, false]])
  })

  it('restores the tab when the close throws and the child is still there', async () => {
    const host = installHost({ closeThrows: new Error('provider round trip failed') })

    const outcome = await closeStructuredAgentSessionChild(SESSION)

    expect(outcome.stopped).toBe(false)
    expect(outcome.closeAttempted).toBe(true)
    expect(outcome.reason).toBe('provider round trip failed')
    expect(host.visible.has(SESSION)).toBe(true)
    expect(host.setSessionTabVisibility.mock.calls).toEqual([
      [SESSION, false],
      [SESSION, true]
    ])
  })

  it('restores the tab when the post-close observation is not `exited`', async () => {
    const host = installHost({ stuck: true })

    const outcome = await closeStructuredAgentSessionChild(SESSION)

    expect(outcome.stopped).toBe(false)
    expect(outcome.closeAttempted).toBe(true)
    expect(host.visible.has(SESSION)).toBe(true)
    expect(host.setSessionTabVisibility.mock.calls).toEqual([
      [SESSION, false],
      [SESSION, true]
    ])
  })

  it('leaves the tab retired when a close throws PAST a proven exit', async () => {
    // `closeStructuredSessionsForWorktree` re-observes and counts this session closed; republishing
    // the tab here would resurrect it at the next launch for a workspace that is gone.
    const host = installHost({ settledThenThrows: true })

    const outcome = await closeStructuredAgentSessionChild(SESSION)

    expect(outcome.stopped).toBe(false)
    expect(host.visible.has(SESSION)).toBe(false)
    expect(host.setSessionTabVisibility.mock.calls).toEqual([[SESSION, false]])
  })

  it('does not put the tab back when the caller is discarding the workspace anyway', async () => {
    // Worktree teardown passes this off for a removal that cannot refuse — force, and the
    // folder-workspace paths. A tab put back there is a durable reference to a workspace that is
    // about to be gone, so it republishes the chat at the next launch pointing at it.
    const host = installHost({ stuck: true })

    const outcome = await closeStructuredAgentSessionChild(SESSION, {
      restoreTabOnUnprovenClose: false
    })

    expect(outcome.stopped).toBe(false)
    expect(host.visible.has(SESSION)).toBe(false)
    expect(host.setSessionTabVisibility.mock.calls).toEqual([[SESSION, false]])
  })

  it('does not publish a tab for a session that was already hidden', async () => {
    const host = installHost({ closeThrows: new Error('provider round trip failed'), visible: [] })

    await closeStructuredAgentSessionChild(SESSION)

    expect(host.visible.has(SESSION)).toBe(false)
    expect(host.setSessionTabVisibility.mock.calls).toEqual([[SESSION, false]])
  })

  it('does not roll back a visibility write that never landed', async () => {
    const host = installHost({ visibilityThrows: new Error('visibility write failed') })

    const outcome = await closeStructuredAgentSessionChild(SESSION)

    expect(outcome).toEqual({
      stopped: false,
      closeAttempted: false,
      reason: 'visibility write failed'
    })
    expect(host.close).not.toHaveBeenCalled()
    expect(host.setSessionTabVisibility.mock.calls).toEqual([[SESSION, false]])
  })

  it('keeps the original failure when the restore itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = installHost({ stuck: true })
    host.setSessionTabVisibility.mockImplementation(async (_sessionId, isVisible) => {
      if (isVisible) {
        throw new Error('agent_session_identity_required')
      }
    })

    const outcome = await closeStructuredAgentSessionChild(SESSION)

    expect(outcome.stopped).toBe(false)
    expect(outcome.closeAttempted).toBe(true)
    expect(outcome.reason).not.toContain('agent_session_identity_required')
    expect(warn).toHaveBeenCalled()
  })

  it('claims nothing when the visible-tab index cannot be read', async () => {
    const host = installHost({ indexThrows: true, closeThrows: new Error('boom') })

    await closeStructuredAgentSessionChild(SESSION)

    expect(host.setSessionTabVisibility.mock.calls).toEqual([[SESSION, false]])
  })

  it('reports no close attempt when no host is installed', async () => {
    hostRef.current = null

    const outcome = await closeStructuredAgentSessionChild(SESSION)

    expect(outcome.stopped).toBe(false)
    expect(outcome.closeAttempted).toBe(false)
  })
})
