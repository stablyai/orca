import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatQueueStore } from './queue-store'

describe('NativeChatQueueStore', () => {
  const directories: string[] = []
  afterEach(() =>
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }))
  )

  it('persists order and restores an in-flight PTY delivery as uncertain', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-native-chat-queue-'))
    directories.push(directory)
    const store = new NativeChatQueueStore(directory)
    const first = store.enqueue('tab:leaf', 'first', ['/one.png'], 'chat', 0)
    const second = store.enqueue('tab:leaf', '/compact', [], 'command', first.revision)
    const reordered = store.reorder(
      'tab:leaf',
      [second.items[1].id, second.items[0].id],
      second.revision
    )
    const claimed = store.claim('tab:leaf', reordered.revision)

    const restored = new NativeChatQueueStore(directory).snapshot('tab:leaf')
    expect(restored.items).toEqual([
      expect.objectContaining({ text: '/compact', kind: 'command', state: 'uncertain' }),
      expect.objectContaining({ text: 'first', imagePaths: ['/one.png'], state: 'pending' })
    ])
    expect(new NativeChatQueueStore(directory).snapshot('tab:leaf').items[0].state).toBe(
      'uncertain'
    )

    const retried = new NativeChatQueueStore(directory).retry(
      'tab:leaf',
      claimed.items[0].id,
      restored.revision
    )
    expect(retried.items[0].state).toBe('pending')
  })

  it('reserves a composer edit until the updated prompt is submitted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-native-chat-queue-'))
    directories.push(directory)
    const store = new NativeChatQueueStore(directory)
    const queued = store.enqueue('tab:leaf', 'original', ['/one.png'], 'chat', 0)
    const messageId = queued.items[0].id
    const editing = store.beginEdit('tab:leaf', messageId, queued.revision)

    expect(store.claim('tab:leaf', editing.revision).items[0].state).toBe('paused')

    const edited = store.edit('tab:leaf', messageId, '/compact', [], 'command', editing.revision)
    const claimed = store.claim('tab:leaf', edited.revision)
    expect(claimed.items[0]).toMatchObject({
      text: '/compact',
      imagePaths: [],
      kind: 'command',
      state: 'submitting'
    })
  })

  it('pauses and resumes a non-empty PTY queue only through explicit controls', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-native-chat-queue-'))
    directories.push(directory)
    const store = new NativeChatQueueStore(directory)
    const queued = store.enqueue('tab:leaf', 'first', [], 'chat', 0)

    const paused = store.pause('tab:leaf', queued.revision)
    expect(paused.paused).toBe('interrupted')
    expect(store.claim('tab:leaf', paused.revision).items[0].state).toBe('pending')

    const resumed = store.resume('tab:leaf', paused.revision)
    expect(resumed.paused).toBeUndefined()
    expect(store.claim('tab:leaf', resumed.revision).items[0].state).toBe('submitting')
  })
})
