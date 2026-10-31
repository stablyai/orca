import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetOpenableNotifications,
  hasOpenableNotification,
  openLatestNotification,
  registerOpenableNotification
} from './openable-notifications'
import type { StructuredAttentionOrigin } from '../../shared/agent-session-attention'

afterEach(() => {
  while (openLatestNotification()) {
    // drain the module-level list between tests
  }
})

describe('openable notifications', () => {
  it('opens the newest registered notification first, then the older ones', () => {
    const older = vi.fn()
    const newer = vi.fn()
    registerOpenableNotification(older)
    registerOpenableNotification(newer)

    expect(openLatestNotification()).toBe(true)
    expect(newer).toHaveBeenCalledTimes(1)
    expect(older).not.toHaveBeenCalled()

    expect(openLatestNotification()).toBe(true)
    expect(older).toHaveBeenCalledTimes(1)

    expect(hasOpenableNotification()).toBe(false)
    expect(openLatestNotification()).toBe(false)
  })

  it('skips notifications that were unregistered before the shortcut fired', () => {
    const kept = vi.fn()
    const clicked = vi.fn()
    registerOpenableNotification(kept)
    const unregister = registerOpenableNotification(clicked)
    unregister()
    // A repeated unregister must not drop another entry.
    unregister()

    expect(openLatestNotification()).toBe(true)
    expect(kept).toHaveBeenCalledTimes(1)
    expect(clicked).not.toHaveBeenCalled()
  })

  it('replaces an earlier notification with the same id', () => {
    const first = vi.fn()
    const replacement = vi.fn()
    registerOpenableNotification(first, { id: 'agent-1' })
    registerOpenableNotification(replacement, { id: 'agent-1' })

    expect(openLatestNotification()).toBe(true)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(openLatestNotification()).toBe(false)
    expect(first).not.toHaveBeenCalled()
  })

  it('forgets notifications retired as read by id', () => {
    const unread = vi.fn()
    const read = vi.fn()
    registerOpenableNotification(unread, { id: 'unread' })
    registerOpenableNotification(read, { id: 'read' })

    forgetOpenableNotifications(['read'])

    expect(openLatestNotification()).toBe(true)
    expect(unread).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })

  it("retires a read pane's unpositioned notifications but keeps positioned alerts past the read", () => {
    const origin = (sequence: number): StructuredAttentionOrigin => ({
      scope: {
        executionHostId: 'runtime:remote-host',
        wslDistro: null,
        workspaceId: 'remote-folder',
        workspaceKind: 'folder'
      },
      sessionId: 'session-1',
      cause: { kind: 'prompt', promptId: `prompt-${sequence}` },
      journalCursor: { epoch: 'journal', sequence }
    })
    const covered = vi.fn()
    const pastRead = vi.fn()
    const completion = vi.fn()
    const bell = vi.fn()
    registerOpenableNotification(covered, { id: 'A', paneKey: 'tab-1:leaf', origin: origin(1) })
    registerOpenableNotification(pastRead, { id: 'B', paneKey: 'tab-1:leaf', origin: origin(2) })
    registerOpenableNotification(completion, { id: 'done', paneKey: 'tab-1:leaf' })
    registerOpenableNotification(bell, { paneKey: 'tab-1:leaf' })

    forgetOpenableNotifications(
      [],
      [
        {
          paneKey: 'tab-1:leaf',
          read: { sessionId: 'session-1', observedCursor: { epoch: 'journal', sequence: 1 } }
        }
      ]
    )

    expect(openLatestNotification()).toBe(true)
    expect(openLatestNotification()).toBe(false)
    expect(pastRead).toHaveBeenCalledTimes(1)
    expect(covered).not.toHaveBeenCalled()
    expect(completion).not.toHaveBeenCalled()
    expect(bell).not.toHaveBeenCalled()
  })

  it('keeps only the 50 newest notifications', () => {
    const opens = Array.from({ length: 51 }, () => vi.fn())
    for (const open of opens) {
      registerOpenableNotification(open)
    }

    let opened = 0
    while (openLatestNotification()) {
      opened += 1
    }

    expect(opened).toBe(50)
    expect(opens[0]).not.toHaveBeenCalled()
    expect(opens[50]).toHaveBeenCalledTimes(1)
  })
})
