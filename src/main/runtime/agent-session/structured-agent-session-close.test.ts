import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
// Child exit proof precedes advisory tab cleanup; failed stops retain the original surface.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCloseCause } from '../../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { closeStructuredAgentSessionChild } = await import('./structured-agent-session-close')

const SESSION = 'session-1'
const TAB_ID = 'tab-of-session-1'

function record(sessionId: string): AgentSessionRecord {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, runtimeFence: 1 }))
  return {
    ...record,
    location: { ...record.location, workspaceId: 'repo_1::/tmp/wt-a', workspaceKind: 'folder' }
  }
}

type HostOptions = {
  alreadyReleased?: boolean
  skipAdmission?: boolean
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

/** The hide a close sends; its hidden notice waits for the close's outcome. */
const HIDE_PROVED_CLOSE = [
  SESSION,
  false,
  undefined,
  { deferHiddenNotice: true, check: expect.any(Function) }
]

function installHost(options: HostOptions = {}) {
  const entry = record(SESSION)
  if (options.alreadyReleased) {
    entry.lease.claimStatus = 'released'
    entry.lease.deathEvidence = { kind: 'exit-observed', detail: 'natural exit', observedAt: 1 }
  }
  const held = new Set(options.alreadyReleased ? [] : [SESSION])
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
  const notifySessionTabHidden = vi.fn()
  const close = vi.fn(
    async (sessionId: string, _cause: StructuredAgentSessionCloseCause, admit?: () => boolean) => {
      if (!options.skipAdmission && admit && !admit()) {
        throw new Error('The user kept this chat open.')
      }
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
    }
  )
  const log = recordingStructuredAgentSessionLogger()
  hostRef.current = {
    deps: {
      logger: log.logger,
      store: {
        getConversation: (id: string) =>
          id === SESSION ? agentSessionConversationView(entry) : null,
        getSessionTabId: (id: string) => {
          if (options.indexThrows) {
            throw new Error('visible tab index unreadable')
          }
          return visible.has(id) ? TAB_ID : null
        }
      }
    },
    getSessionTabId: (id: string) => {
      if (options.indexThrows) {
        throw new Error('unreadable')
      }
      return visible.has(id) ? TAB_ID : null
    },
    isSessionTabVisible: (id: string) => visible.has(id),
    hasSession: (sessionId: string) => held.has(sessionId),
    setSessionTabVisibility,
    notifySessionTabHidden,
    close
  }
  return { close, setSessionTabVisibility, notifySessionTabHidden, visible, log }
}

function runtimeFor(retire = vi.fn(() => true)) {
  let raw: { worktreeId: string; tabId: string } | null = {
    worktreeId: 'repo_1::/tmp/wt-a',
    tabId: 'raw-retry'
  }
  return {
    currentLocalStructuredSessionPresentation: () => raw,
    captureStructuredAgentSessionPresentation: () => ({ raw, saved: [] }),
    retireStructuredAgentSessionTabFromSnapshot: (...args: Parameters<typeof retire>) => {
      raw = null
      return retire(...args)
    },
    removeCapturedStructuredSessionSavedTabs: vi.fn()
  }
}

describe('closeStructuredAgentSessionChild admitted surface', () => {
  beforeEach(() => {
    hostRef.current = null
    vi.restoreAllMocks()
  })

  it.each(['false', 'throws', 'unreached'] as const)(
    'does not turn %s admission into success from independent exit proof',
    async (mode) => {
      const host = installHost({ alreadyReleased: true, skipAdmission: mode === 'unreached' })
      const runtime = runtimeFor()
      const afterClose = vi.fn()
      const admitClose = vi.fn(() => {
        if (mode === 'throws') {
          throw new Error('Admission failed')
        }
        return false
      })
      expect(
        await closeStructuredAgentSessionChild(SESSION, { runtime, afterClose, admitClose })
      ).toMatchObject({
        stopped: false,
        closeAttempted: true
      })
      expect(admitClose).toHaveBeenCalledTimes(mode === 'unreached' ? 0 : 1)
      expect(afterClose).not.toHaveBeenCalled()
      expect(host.visible.has(SESSION)).toBe(true)
      expect(host.setSessionTabVisibility).not.toHaveBeenCalled()
      expect(runtime.currentLocalStructuredSessionPresentation()).not.toBeNull()
      expect(runtime.removeCapturedStructuredSessionSavedTabs).not.toHaveBeenCalled()
    }
  )

  it('proves stop before hiding and retires only the captured raw surface', async () => {
    const host = installHost()
    const retire = vi.fn(() => true)
    const afterClose = vi.fn()
    expect(
      await closeStructuredAgentSessionChild(SESSION, {
        runtime: runtimeFor(retire),
        afterClose
      })
    ).toEqual({ stopped: true, closeAttempted: true })
    expect(host.visible.has(SESSION)).toBe(false)
    expect(retire).toHaveBeenCalledWith(SESSION, 'raw-retry', 'repo_1::/tmp/wt-a')
    expect(host.setSessionTabVisibility.mock.calls).toEqual([HIDE_PROVED_CLOSE])
    expect(host.close.mock.invocationCallOrder[0]).toBeLessThan(
      host.setSessionTabVisibility.mock.invocationCallOrder[0]!
    )
    expect(afterClose).toHaveBeenCalledOnce()
  })

  it.each([{ closeThrows: new Error('provider failed') }, { stuck: true }])(
    'leaves visibility unchanged when child exit is unproven: %j',
    async (options) => {
      const host = installHost(options)
      const afterClose = vi.fn()
      expect(await closeStructuredAgentSessionChild(SESSION, { afterClose })).toMatchObject({
        stopped: false,
        closeAttempted: true
      })
      expect(host.visible.has(SESSION)).toBe(true)
      expect(host.setSessionTabVisibility).not.toHaveBeenCalled()
      expect(afterClose).toHaveBeenCalledOnce()
    }
  )

  it.each([{ settledThenThrows: true }, { visibilityThrows: new Error('visibility failed') }])(
    'keeps actual child proof despite a later error: %j',
    async (options) => {
      const host = installHost(options)
      const retire = vi.fn(() => true)
      expect(
        await closeStructuredAgentSessionChild(SESSION, {
          runtime: runtimeFor(retire)
        })
      ).toEqual({ stopped: true, closeAttempted: true })
      expect(host.close).toHaveBeenCalledOnce()
      expect(retire).toHaveBeenCalledWith(SESSION, 'raw-retry', 'repo_1::/tmp/wt-a')
    }
  )

  it('does no surface cleanup when visibility cannot be captured, and claims no attempt without a host', async () => {
    const host = installHost({ indexThrows: true })
    expect(await closeStructuredAgentSessionChild(SESSION)).toEqual({
      stopped: true,
      closeAttempted: true
    })
    expect(host.setSessionTabVisibility).not.toHaveBeenCalled()
    hostRef.current = null
    expect(await closeStructuredAgentSessionChild(SESSION)).toMatchObject({
      stopped: false,
      closeAttempted: false
    })
  })
})

it('still stops when runtime capture fails, without treating unknown as an absent raw row', async () => {
  const host = installHost()
  const runtime = runtimeFor()
  runtime.captureStructuredAgentSessionPresentation = () => {
    throw new Error('unreadable layout')
  }
  expect(await closeStructuredAgentSessionChild(SESSION, { runtime })).toEqual({
    stopped: true,
    closeAttempted: true
  })
  expect(host.close).toHaveBeenCalledOnce()
  expect(host.setSessionTabVisibility).not.toHaveBeenCalled()
})

it('protects a newer actual raw Retry spelling even while the durable table id is unchanged', async () => {
  const host = installHost({ visible: [] })
  const runtime = runtimeFor()
  const raw = { worktreeId: 'repo_1::/tmp/wt-a', tabId: 'newer-raw-retry' }
  const close = host.close.getMockImplementation()!
  host.close.mockImplementation(async (...args) => {
    await close(...args)
    runtime.currentLocalStructuredSessionPresentation = () => raw
  })
  expect(await closeStructuredAgentSessionChild(SESSION, { runtime })).toMatchObject({
    stopped: true
  })
  expect(host.setSessionTabVisibility).not.toHaveBeenCalled()
  expect(runtime.removeCapturedStructuredSessionSavedTabs).not.toHaveBeenCalled()
})

it('does not replace successful provider proof with a presentation cleanup exception', async () => {
  installHost()
  const runtime = runtimeFor()
  runtime.retireStructuredAgentSessionTabFromSnapshot = () => {
    throw new Error('publication failed')
  }
  expect(await closeStructuredAgentSessionChild(SESSION, { runtime })).toEqual({
    stopped: true,
    closeAttempted: true
  })
})
