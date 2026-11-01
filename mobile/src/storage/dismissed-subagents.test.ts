import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissedSubagentsInSession,
  dismissedSubagentsStorageKey,
  writeDismissedSubagentSession
} from './dismissed-subagents'

const stored = vi.hoisted(() => new Map<string, string>())

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      stored.delete(key)
    })
  }
}))

const key = dismissedSubagentsStorageKey('host/1', 'wt/1')

beforeEach(() => {
  stored.clear()
})

describe('writeDismissedSubagentSession', () => {
  it('keeps one session map and drops it when the session is empty', async () => {
    await writeDismissedSubagentSession('host/1', 'wt/1', 'sess', {
      '/root/child': 'failed'
    })
    expect(dismissedSubagentsInSession(stored.get(key) ?? null, 'sess')).toEqual({
      '/root/child': 'failed'
    })

    await writeDismissedSubagentSession('host/1', 'wt/1', 'other', { lost: 'unverifiable' })
    expect(dismissedSubagentsInSession(stored.get(key) ?? null, 'sess')['/root/child']).toBe(
      'failed'
    )
    expect(dismissedSubagentsInSession(stored.get(key) ?? null, 'other')).toEqual({
      lost: 'unverifiable'
    })

    await writeDismissedSubagentSession('host/1', 'wt/1', 'sess', {})
    expect(dismissedSubagentsInSession(stored.get(key) ?? null, 'sess')).toEqual({})
    await writeDismissedSubagentSession('host/1', 'wt/1', 'other', {})
    expect(stored.has(key)).toBe(false)
  })

  it('applies overlapping writes in order', async () => {
    const first = writeDismissedSubagentSession('host/1', 'wt/1', 'sess', { bad: 'failed' })
    const second = writeDismissedSubagentSession('host/1', 'wt/1', 'sess', {
      bad: 'failed',
      lost: 'unverifiable'
    })
    await Promise.all([first, second])
    expect(dismissedSubagentsInSession(stored.get(key) ?? null, 'sess')).toEqual({
      bad: 'failed',
      lost: 'unverifiable'
    })
  })
})
