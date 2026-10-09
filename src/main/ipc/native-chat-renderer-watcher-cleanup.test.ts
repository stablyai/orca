import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const listeners = new Map<string, (event: unknown, args: unknown) => void>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, listener: (event: unknown, args: unknown) => void) => {
      listeners.set(channel, listener)
    }
  }
}))

import { clearNativeChatSubscriptions, registerNativeChatHandlers } from './native-chat'
import { getActiveNativeChatWatcherCount } from '../native-chat/transcript-watcher-count'

let transcriptDirectory = ''
let transcriptPath = ''

beforeEach(async () => {
  clearNativeChatSubscriptions()
  registerNativeChatHandlers()
  transcriptDirectory = await mkdtemp(join(tmpdir(), 'orca-native-chat-renderer-lifetime-'))
  transcriptPath = join(transcriptDirectory, 'session.jsonl')
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      timestamp: '2026-09-25T00:00:00.000Z',
      message: { role: 'user', content: 'Viewer fixture' }
    })}\n`
  )
})

afterEach(async () => {
  clearNativeChatSubscriptions()
  await rm(transcriptDirectory, { recursive: true, force: true })
})

it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
  'releases the installed transcript watcher on %s',
  async (event) => {
    const sender = Object.assign(new EventEmitter(), {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn()
    })
    const before = getActiveNativeChatWatcherCount()
    listeners.get('nativeChat:subscribe')?.(
      { sender },
      { subscriptionId: 'view', agent: 'claude', sessionId: 'session', transcriptPath }
    )
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalled())
    expect(getActiveNativeChatWatcherCount()).toBe(before + 1)
    sender.emit(event)
    expect(getActiveNativeChatWatcherCount()).toBe(before)
  }
)
