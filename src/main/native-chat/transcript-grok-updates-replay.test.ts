import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { subscribeNativeChatTranscript } from './transcript-watch'
import { readGrokUpdatesReplay } from './transcript-grok-updates-replay'

let root: string, filePath: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-grok-rewind-'))
  await mkdir(join(root, 'child'))
  filePath = join(root, 'child', 'updates.jsonl')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function row(
  update: Record<string, unknown>,
  method = 'session/update',
  sessionId = 'child'
): string {
  return `${JSON.stringify({ timestamp: 1788814800, method, params: { sessionId, update } })}\n`
}
const user = (text: string, meta?: Record<string, unknown>): string =>
  row({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text },
    ...(meta ? { _meta: meta } : {})
  })
const answer = (text: string): string =>
  row({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const rewind = (index: number, sessionId = 'child'): string =>
  row(
    { sessionUpdate: 'rewind_marker', target_prompt_index: index },
    '_x.ai/session/update',
    sessionId
  )
const texts = (messages: NativeChatMessage[]): string[] =>
  messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )

describe('Grok presentation rewind replay', () => {
  it('replays repeated rewinds and preserves original byte offsets for pagination', async () => {
    const survivor = user('keep') + answer('kept answer')
    const oldBranch = user('drop') + answer('discarded answer')
    const history =
      survivor +
      oldBranch +
      rewind(1) +
      user('also drop') +
      answer('discarded again') +
      rewind(1) +
      user('replacement') +
      answer('new answer')
    await writeFile(filePath, history)
    const full = await readNativeChatTranscript('grok', 'child', { filePath })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(texts(full.messages)).toEqual(['keep', 'kept answer', 'replacement', 'new answer'])
    const tail = await readNativeChatTranscriptTail({
      agent: 'grok',
      sessionId: 'child',
      filePath,
      limit: 2
    })
    if ('error' in tail) {
      throw new Error(tail.error)
    }
    expect(texts(tail.messages)).toEqual(['replacement', 'new answer'])
    expect(tail.beforeOffset).toBe(
      Buffer.byteLength(history.slice(0, history.indexOf(user('replacement'))))
    )
    const older = await readNativeChatTranscriptTail({
      agent: 'grok',
      sessionId: 'child',
      filePath,
      limit: 2,
      beforeOffset: tail.beforeOffset
    })
    if ('error' in older) {
      throw new Error(older.error)
    }
    expect(texts(older.messages)).toEqual(['keep', 'kept answer'])
    expect(older.hasMore).toBe(false)
    expect(older.beforeOffset).toBe(0)
  })

  it('counts user runs, excludes host turns, and respects progressive promptIndex markers', async () => {
    await writeFile(
      filePath,
      user('legacy first ') +
        user('legacy continuation') +
        answer('legacy answer') +
        user('marked first', { promptIndex: 20 }) +
        user('same marked prompt', { promptIndex: 20 }) +
        user('marked second', { promptIndex: 21 }) +
        user('host injection', { hostTurn: true, promptIndex: 22 }) +
        answer('tool boundary') +
        user('unmarked phantom') +
        answer('phantom reply') +
        user('marked third', { promptIndex: 23 }) +
        rewind(2)
    )
    const result = await readGrokUpdatesReplay(filePath)
    expect(texts(result.messages)).toEqual([
      'legacy first ',
      'legacy continuation',
      'legacy answer',
      'marked first',
      'same marked prompt'
    ])
  })

  it('does not count host turns as prompts and ignores foreign or out-of-range rewind targets', async () => {
    await writeFile(
      filePath,
      user('host', { hostTurn: true }) +
        user('first') +
        answer('answer') +
        user('second') +
        rewind(1)
    )
    expect(texts((await readGrokUpdatesReplay(filePath)).messages)).toEqual([
      'host',
      'first',
      'answer'
    ])
    await appendFile(filePath, rewind(99) + rewind(0, 'grandchild') + answer('still kept'))
    expect(texts((await readGrokUpdatesReplay(filePath)).messages)).toEqual([
      'host',
      'first',
      'answer',
      'still kept'
    ])
  })

  it('retains marker mode after rewinding and removes target prompt inclusively', async () => {
    await writeFile(
      filePath,
      user('marked', { promptIndex: 0 }) +
        answer('old') +
        rewind(0) +
        user('unmarked phantom') +
        answer('phantom answer') +
        user('new marked', { promptIndex: 1 }) +
        rewind(0)
    )
    expect(texts((await readGrokUpdatesReplay(filePath)).messages)).toEqual([
      'unmarked phantom',
      'phantom answer'
    ])
  })

  it('replaces the visible timeline after an appended rewind and later work', async () => {
    await writeFile(filePath, user('keep') + answer('kept') + user('discard') + answer('discarded'))
    let visible: string[] = []
    const appends: NativeChatMessage[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'grok',
      sessionId: 'child',
      filePath,
      initialLimit: 100,
      onInitialSnapshot: (messages) => {
        visible = texts(messages)
      },
      onReplace: (messages) => {
        visible = texts(messages)
      },
      onAppend: (messages) => appends.push(...messages),
      debounceMs: 1,
      reconciliationIntervalMs: 20
    })
    try {
      await expect.poll(() => visible).toEqual(['keep', 'kept', 'discard', 'discarded'])
      const marker = rewind(1)
      await appendFile(filePath, marker.slice(0, -1))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(visible).toEqual(['keep', 'kept', 'discard', 'discarded'])
      await appendFile(filePath, `\n${user('new')}${answer('new answer')}`)
      await expect.poll(() => visible).toEqual(['keep', 'kept', 'new', 'new answer'])
      await appendFile(filePath, rewind(0))
      await expect.poll(() => visible).toEqual([])
      expect(appends).toEqual([])
    } finally {
      sub.unsubscribe()
    }
  })

  it('requires replacement delivery rather than silently retaining deleted branches', async () => {
    await writeFile(filePath, user('task'))
    await expect(
      subscribeNativeChatTranscript({
        agent: 'grok',
        sessionId: 'child',
        filePath,
        onAppend: () => {}
      })
    ).rejects.toThrow('requires replacement snapshots')
  })

  it('preserves loaded earlier pages and delivers every ordinary append beyond the initial window', async () => {
    await writeFile(filePath, user('keep') + answer('kept') + user('later') + answer('latest'))
    let visible: string[] = []
    const replacements: string[][] = []
    const batches: number[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'grok',
      sessionId: 'child',
      filePath,
      initialLimit: 1,
      onInitialSnapshot: (messages) => {
        visible = texts(messages)
      },
      onReplace: (messages) => {
        visible = texts(messages)
        replacements.push([...visible])
      },
      onAppend: (messages) => {
        visible.push(...texts(messages))
        batches.push(messages.length)
      },
      debounceMs: 1,
      reconciliationIntervalMs: 20
    })
    try {
      await expect.poll(() => visible).toEqual(['latest'])
      const loaded = await readGrokUpdatesReplay(filePath)
      visible = texts(loaded.messages)
      const additions = Array.from({ length: 45 }, (_, index) => `append-${index}`)
      await appendFile(filePath, additions.map(answer).join(''))
      await expect.poll(() => visible).toEqual(['keep', 'kept', 'later', 'latest', ...additions])
      expect(replacements).toEqual([])
      expect(batches).toEqual([40, 5])
      await appendFile(filePath, rewind(1))
      await expect.poll(() => visible).toEqual(['kept'])
      expect(replacements).toEqual([['kept']])
      await appendFile(filePath, answer('after rewind'))
      await expect.poll(() => visible).toEqual(['kept', 'after rewind'])
      expect(replacements).toEqual([['kept']])
      expect(batches).toEqual([40, 5, 1])
    } finally {
      sub.unsubscribe()
    }
  })

  it('honors cancellation, complete-line policy and the existing oversized-record bound', async () => {
    await writeFile(filePath, user('x'.repeat(2 * 1024 * 1024)) + user('visible') + answer('done'))
    await expect(readGrokUpdatesReplay(filePath)).rejects.toThrow('transcript read bound')
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(
      readGrokUpdatesReplay(filePath, 10, undefined, true, abort.signal)
    ).rejects.toThrow()
    await writeFile(filePath, user('trailing').trimEnd())
    expect((await readGrokUpdatesReplay(filePath, 10, undefined, false)).messages).toEqual([])
    expect(texts((await readGrokUpdatesReplay(filePath)).messages)).toEqual(['trailing'])
  })
})
