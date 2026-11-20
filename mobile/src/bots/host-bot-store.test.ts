import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { PhoneBot } from './host-bots-operations'
import {
  publishHostBot,
  publishHostBots,
  publishHostBotStatuses,
  useHostBotsEntry
} from './host-bot-store'

// Mounts a reader so each publish reaches it through the store's subscription.
function renderHook<T>(read: () => T): { result: { current: T | undefined } } {
  const result: { current: T | undefined } = { current: undefined }
  function Reader(): null {
    result.current = read()
    return null
  }
  act(() => {
    create(createElement(Reader))
  })
  return { result }
}

function bot(overrides: Partial<PhoneBot> = {}): PhoneBot {
  return {
    id: 'atlas',
    name: 'Atlas',
    folderWorkspaceId: 'atlas-home',
    avatar: null,
    paused: false,
    agent: 'claude',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    ...overrides
  }
}

describe('host bot store', () => {
  it('shows an edit and the list’s status on every reader of that host', () => {
    const key = 'host-a\nlocal'
    publishHostBots(key, { bots: [bot()], hideBotCreated: true })
    const { result } = renderHook(() => useHostBotsEntry(key))

    act(() => publishHostBot(key, bot({ paused: true })))
    expect(result.current?.bots[0]?.paused).toBe(true)

    act(() => publishHostBotStatuses(key, new Map([['atlas', 'working']])))
    expect(result.current?.statusByBotId.get('atlas')).toBe('working')

    // A re-read keeps the list's status until the list rolls up again.
    act(() => publishHostBots(key, { bots: [bot()], hideBotCreated: true }))
    expect(result.current?.statusByBotId.get('atlas')).toBe('working')

    const before = result.current
    act(() => publishHostBotStatuses(key, new Map([['atlas', 'working']])))
    expect(result.current).toBe(before)
  })
})
