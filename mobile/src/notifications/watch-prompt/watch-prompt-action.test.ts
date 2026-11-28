import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readOrcaPushPayload } from '../payload-identity/push-payload'
import {
  forgetWatchPrompt,
  pendingWatchPromptFromNotification,
  rememberWatchPrompt,
  resetWatchPromptsForTests,
  subscribeWatchPrompts
} from './watch-prompt-action'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key)
    })
  }
}))

const publicKey = Buffer.alloc(32, 7)
const publicKeyB64 = publicKey.toString('base64')
const hostFingerprint = Buffer.from(sha256(publicKey)).toString('base64url').slice(0, 16)
const hosts = [{ id: 'host-1', publicKeyB64 }]
const reply = { allow: '1', deny: '\u001b' }

function payload(overrides: Record<string, unknown> = {}) {
  return {
    orca: {
      hostFingerprint,
      paneKey: 'tab:leaf',
      worktreeId: 'folder:/work',
      promptReply: reply,
      ...overrides
    }
  }
}

beforeEach(() => {
  storage.clear()
  resetWatchPromptsForTests()
  vi.mocked(AsyncStorage.getItem).mockClear()
})

describe('pendingWatchPromptFromNotification', () => {
  it('reads an allow tap, including a stringified FCM reply', () => {
    expect(pendingWatchPromptFromNotification('allow', payload(), hosts)).toEqual({
      hostId: 'host-1',
      worktreeId: 'folder:/work',
      paneKey: 'tab:leaf',
      action: 'allow',
      reply
    })
    expect(
      readOrcaPushPayload({
        hostFingerprint,
        promptReply: JSON.stringify(reply),
        paneKey: 'tab:leaf',
        worktreeId: 'folder:/work'
      })?.promptReply
    ).toEqual(reply)
  })

  it('ignores a body tap, an unknown host, and a push with no reply', () => {
    expect(
      pendingWatchPromptFromNotification(
        'expo.modules.notifications.actions.DEFAULT',
        payload(),
        hosts
      )
    ).toBeNull()
    expect(pendingWatchPromptFromNotification('deny', payload(), [])).toBeNull()
    expect(
      pendingWatchPromptFromNotification('allow', payload({ promptReply: undefined }), hosts)
    ).toBeNull()
  })
})

describe('rememberWatchPrompt', () => {
  it('replays a stored decision once and drops it after it is answered', async () => {
    const seen: string[] = []
    const pending = pendingWatchPromptFromNotification('deny', payload(), hosts)
    if (!pending) {
      throw new Error('expected a pending watch prompt')
    }
    await rememberWatchPrompt(pending)
    const stop = subscribeWatchPrompts(async (item) => {
      seen.push(item.action)
    })
    await vi.waitFor(() => expect(seen).toEqual(['deny']))
    await forgetWatchPrompt(pending)
    expect(storage.size).toBe(0)
    stop()
  })
})
