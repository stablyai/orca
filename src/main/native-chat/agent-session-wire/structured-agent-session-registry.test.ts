import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionsHeldChanged,
  setStructuredAgentSessionHost,
  structuredAgentSessionsHeld
} from './structured-agent-session-registry'

function fakeHost(initiallyHeld: boolean): {
  host: StructuredAgentSessionHost
  recordFirstChat: () => void
} {
  let holds = initiallyHeld
  const watchers = new Set<() => void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only these two members.
  const host = {
    holdsSessions: () => holds,
    onSessionsHeld: (listener: () => void) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    }
  } as unknown as StructuredAgentSessionHost
  return {
    host,
    recordFirstChat: () => {
      holds = true
      watchers.forEach((watcher) => watcher())
    }
  }
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

// The renderer mirrors this machine's chats once one exists, e.g. when a paired client creates the
// first chat here while the chat setting is off. Building the host is not holding a chat.
describe("the structured host's held-chats signal", () => {
  it('stays false when a host is built over a profile with no chat', () => {
    const listener = vi.fn()
    const stop = onStructuredAgentSessionsHeldChanged(listener)

    setStructuredAgentSessionHost(fakeHost(false).host)

    expect(structuredAgentSessionsHeld()).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it('turns true once, when the first chat is recorded', () => {
    const listener = vi.fn()
    const stop = onStructuredAgentSessionsHeldChanged(listener)
    const { host, recordFirstChat } = fakeHost(false)
    setStructuredAgentSessionHost(host)

    recordFirstChat()
    recordFirstChat()

    expect(structuredAgentSessionsHeld()).toBe(true)
    expect(listener.mock.calls).toEqual([[true]])
    stop()
  })

  it('is true as soon as a host restores saved chats', () => {
    const listener = vi.fn()
    const stop = onStructuredAgentSessionsHeldChanged(listener)

    setStructuredAgentSessionHost(fakeHost(true).host)

    expect(listener.mock.calls).toEqual([[true]])
    stop()
  })

  it('never fails the install when a listener throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stopThrowing = onStructuredAgentSessionsHeldChanged(() => {
      throw new Error('webContents destroyed')
    })
    const later = vi.fn()
    const stopLater = onStructuredAgentSessionsHeldChanged(later)
    const { host } = fakeHost(true)

    expect(() => setStructuredAgentSessionHost(host)).not.toThrow()
    expect(getStructuredAgentSessionHost()).toBe(host)
    expect(later).toHaveBeenCalledWith(true)
    stopThrowing()
    stopLater()
  })
})
