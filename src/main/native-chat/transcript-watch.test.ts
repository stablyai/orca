import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  getActiveNativeChatWatcherCount,
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript
} from './transcript-watch'

let tempRoots: string[] = []

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempFile(initial: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-'))
  tempRoots.push(root)
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, initial)
  return filePath
}

// A path inside a fresh temp dir with nothing written yet — simulates a
// just-created session whose agent hasn't flushed its first JSONL line (#8401).
async function pendingFilePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-pending-'))
  tempRoots.push(root)
  return join(root, 'rollout.jsonl')
}

function claudeLine(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}

function claudeEndTurnLine(uuid: string, text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-06-01T10:00:01.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }]
    }
  })}\n`
}

function codexLifecycleLine(
  state: 'task_started' | 'task_complete' | 'turn_aborted',
  turnId = 'turn-1'
): string {
  return `${JSON.stringify({
    type: 'event_msg',
    timestamp: state === 'task_started' ? '2026-06-01T10:00:00.000Z' : '2026-06-01T10:00:01.000Z',
    payload: { type: state, turn_id: turnId }
  })}\n`
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('subscribeNativeChatTranscript', () => {
  it('delivers the offset-0 drain as one initial snapshot, then only live appends', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'first'))
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[][] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onInitialSnapshot: (messages) => snapshots.push(messages),
      onAppend: (messages) => appends.push(messages),
      debounceMs: 5
    })

    expect(sub.watching).toBe(true)
    await waitFor(() => snapshots.length === 1)
    expect(snapshots[0]?.map((message) => message.id)).toEqual(['u-1'])
    expect(appends).toEqual([])

    await appendFile(filePath, claudeLine('a-1', 'assistant', 'reply'))
    await waitFor(() => appends.flat().some((message) => message.id === 'a-1'))
    sub.unsubscribe()

    expect(snapshots).toHaveLength(1)
    expect(appends.flat().map((message) => message.id)).toEqual(['a-1'])
  })

  it('delivers an empty initial snapshot so clients do not remain loading', async () => {
    const filePath = await tempFile('')
    const snapshots: NativeChatMessage[][] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onInitialSnapshot: (messages) => snapshots.push(messages),
      onAppend: () => {},
      debounceMs: 5
    })

    await waitFor(() => snapshots.length === 1)
    sub.unsubscribe()
    expect(snapshots).toEqual([[]])
  })

  it('replays and appends provider-authored turn lifecycle markers', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'first'))
    const lifecycles: NativeChatTurnLifecycle[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onInitialSnapshot: (_messages, _hasMore, _beforeOffset, _error, lifecycle) => {
        if (lifecycle) {
          lifecycles.push(lifecycle)
        }
      },
      onAppend: (_messages, lifecycle) => {
        if (lifecycle) {
          lifecycles.push(lifecycle)
        }
      },
      debounceMs: 5
    })

    await waitFor(() => lifecycles.length === 1)
    await appendFile(filePath, claudeEndTurnLine('a-1', 'done'))
    await waitFor(() => lifecycles.length === 2)
    sub.unsubscribe()

    expect(lifecycles.map((lifecycle) => lifecycle.state)).toEqual(['working', 'completed'])
    expect(lifecycles.map((lifecycle) => lifecycle.turnId)).toEqual(['u-1', 'a-1'])
  })

  it('emits Codex task_complete even when the frame has no visible messages', async () => {
    const filePath = await tempFile(codexLifecycleLine('task_started'))
    const lifecycles: NativeChatTurnLifecycle[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'ignored',
      filePath,
      onInitialSnapshot: (_messages, _hasMore, _beforeOffset, _error, lifecycle) => {
        if (lifecycle) {
          lifecycles.push(lifecycle)
        }
      },
      onAppend: (messages, lifecycle) => {
        expect(messages).toEqual([])
        if (lifecycle) {
          lifecycles.push(lifecycle)
        }
      },
      debounceMs: 5
    })

    await waitFor(() => lifecycles.length === 1)
    await appendFile(filePath, codexLifecycleLine('task_complete'))
    await waitFor(() => lifecycles.length === 2)
    sub.unsubscribe()

    expect(lifecycles).toMatchObject([
      { state: 'working', turnId: 'turn-1' },
      { state: 'completed', turnId: 'turn-1' }
    ])
  })

  it('replays Codex interruption as a terminal lifecycle and visible status row', async () => {
    const filePath = await tempFile(
      codexLifecycleLine('task_started') + codexLifecycleLine('turn_aborted')
    )
    let snapshot:
      | { messages: NativeChatMessage[]; lifecycle: NativeChatTurnLifecycle | undefined }
      | undefined
    const sub = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'ignored',
      filePath,
      initialLimit: 40,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, _error, lifecycle) => {
        snapshot = { messages, lifecycle }
      },
      onAppend: () => {},
      debounceMs: 5
    })

    await waitFor(() => snapshot !== undefined)
    sub.unsubscribe()

    expect(snapshot?.lifecycle).toMatchObject({ state: 'interrupted', turnId: 'turn-1' })
    expect(snapshot?.messages).toMatchObject([
      { role: 'system', blocks: [{ type: 'text', text: 'Conversation interrupted' }] }
    ])
  })

  it('does not replay an older interruption over a newer working turn', async () => {
    const filePath = await tempFile(
      codexLifecycleLine('task_started', 'turn-1') +
        codexLifecycleLine('turn_aborted', 'turn-1') +
        codexLifecycleLine('task_started', 'turn-2')
    )
    const result = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'ignored',
      filePath,
      limit: 40
    })

    expect(result).toMatchObject({ lifecycle: { state: 'working', turnId: 'turn-2' } })
  })

  it('recovers a completion marker even when trailing non-boundary rows follow it', async () => {
    // The lifecycle scan walks newest-first; rows that decode to no boundary
    // (tool-results, harness noise) must not hide an earlier real completion
    // within the window, or a reconnect snapshot would fail to settle.
    const toolResult = `${JSON.stringify({
      type: 'user',
      uuid: 'tool-result-1',
      timestamp: '2026-06-01T10:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }]
      }
    })}\n`
    const noise = `${JSON.stringify({
      type: 'user',
      uuid: 'note-1',
      timestamp: '2026-06-01T10:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>continue</system-reminder>' }]
      }
    })}\n`
    const filePath = await tempFile(claudeEndTurnLine('a-1', 'done') + toolResult + noise)
    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      limit: 40
    })

    expect(result).toMatchObject({ lifecycle: { state: 'completed', turnId: 'a-1' } })
  })

  it('emits a bulk append in bounded ordered batches', async () => {
    const filePath = await tempFile('')
    const batches: NativeChatMessage[][] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => batches.push(messages),
      debounceMs: 5
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await appendFile(
      filePath,
      Array.from({ length: 95 }, (_unused, index) =>
        claudeLine(`bulk-${index}`, 'user', `message-${index}`)
      ).join('')
    )

    await waitFor(() => batches.flat().length === 95)
    sub.unsubscribe()
    expect(batches.map((batch) => batch.length)).toEqual([40, 40, 15])
    expect(batches.flat().map((message) => message.id)).toEqual(
      Array.from({ length: 95 }, (_unused, index) => `bulk-${index}`)
    )
  })

  it('drops one oversized record without retaining or blocking the next append', async () => {
    const filePath = await tempFile('')
    const seen: NativeChatMessage[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await appendFile(
      filePath,
      claudeLine('oversized', 'user', 'x'.repeat(2 * 1024 * 1024)) +
        claudeLine('after-oversized', 'user', 'still delivered')
    )

    await waitFor(() => seen.some((message) => message.id === 'after-oversized'))
    sub.unsubscribe()
    expect(seen.some((message) => message.id === 'oversized')).toBe(false)
  })

  it('returns a bounded tail snapshot with exact pagination state', async () => {
    const transcript = Array.from({ length: 800 }, (_unused, index) =>
      claudeLine(`u-${index}`, 'user', `message-${index}-${'x'.repeat(100)}`)
    ).join('')
    const filePath = await tempFile(transcript)
    const snapshots: { ids: string[]; hasMore: boolean }[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      initialLimit: 2,
      onInitialSnapshot: (messages, hasMore) =>
        snapshots.push({ ids: messages.map((message) => message.id), hasMore }),
      onAppend: () => {},
      debounceMs: 5
    })

    await waitFor(() => snapshots.length === 1)
    sub.unsubscribe()
    expect(snapshots).toEqual([{ ids: ['u-798', 'u-799'], hasMore: true }])
  })

  it('keeps an explicit zero-limit snapshot empty instead of reading unbounded', async () => {
    const filePath = await tempFile(claudeLine('u-0', 'user', 'hello'))
    const snapshots: { ids: string[]; hasMore: boolean }[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      initialLimit: 0,
      onInitialSnapshot: (messages, hasMore) =>
        snapshots.push({ ids: messages.map((message) => message.id), hasMore }),
      onAppend: () => {},
      debounceMs: 5
    })

    await waitFor(() => snapshots.length === 1)
    sub.unsubscribe()
    expect(snapshots).toEqual([{ ids: [], hasMore: false }])
  })

  it('pages older history by byte cursor without resending the growing tail', async () => {
    const filePath = await tempFile(
      Array.from({ length: 10 }, (_unused, index) =>
        claudeLine(`page-${index}`, 'user', `message-${index}`)
      ).join('')
    )
    const newest = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      limit: 3
    })
    if ('error' in newest) {
      throw new Error(newest.error)
    }
    const older = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      limit: 3,
      beforeOffset: newest.beforeOffset
    })

    expect(newest.messages.map((message) => message.id)).toEqual(['page-7', 'page-8', 'page-9'])
    expect('messages' in older && older.messages.map((message) => message.id)).toEqual([
      'page-4',
      'page-5',
      'page-6'
    ])
  })

  it('decodes multi-chunk records once into the bounded tail order', async () => {
    const large = 'x'.repeat(200_000)
    const filePath = await tempFile(
      claudeLine('u-large-1', 'user', large) + claudeLine('u-large-2', 'user', large)
    )
    const snapshots: { ids: string[]; hasMore: boolean }[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      initialLimit: 1,
      onInitialSnapshot: (messages, hasMore) =>
        snapshots.push({ ids: messages.map((message) => message.id), hasMore }),
      onAppend: () => {},
      debounceMs: 5
    })

    await waitFor(() => snapshots.length === 1)
    sub.unsubscribe()
    expect(snapshots).toEqual([{ ids: ['u-large-2'], hasMore: true }])
  })

  it('re-emits from the top on first drain so appended turns are never dropped', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'first'))
    const batches: NativeChatMessage[][] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => batches.push(messages),
      debounceMs: 5
    })

    await appendFile(filePath, claudeLine('a-1', 'assistant', 'reply'))
    await waitFor(() => batches.flat().some((m) => m.id === 'a-1'))

    sub.unsubscribe()

    // Seed-at-0 means the first drain re-reads the whole file; the assembler
    // dedups by id. The appended turn must appear; the pre-existing line may
    // appear too (collapsed downstream by id).
    const ids = batches.flat().map((m) => m.id)
    expect(ids).toContain('a-1')
  })

  it('appends a turn in the gap between initial read and first watcher drain exactly once', async () => {
    // Simulate the read/subscribe race: a turn lands after the caller's
    // readSession EOF but before the watcher's first drain. Seeding at 0 means
    // the first drain reads it; the assembler later dedups by deterministic id.
    const filePath = await tempFile(claudeLine('u-1', 'user', 'first'))
    const seen: NativeChatMessage[] = []

    // The gap turn is written BEFORE subscribe completes its first drain.
    await appendFile(filePath, claudeLine('a-gap', 'assistant', 'raced reply'))

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })

    await waitFor(() => seen.some((m) => m.id === 'a-gap'))
    sub.unsubscribe()

    // The raced turn is present, and not duplicated within a single drain pass.
    expect(seen.filter((m) => m.id === 'a-gap')).toHaveLength(1)
  })

  it('recovers cleanly when a read throws (subscription not left deaf)', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'hi'))
    const seen: NativeChatMessage[] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })

    // Make the file unreadable mid-flight (EACCES on the read path). The drain's
    // try/catch must break and reset `reading` in finally so a later append
    // still tails once permissions are restored.
    await waitFor(() => seen.some((m) => m.id === 'u-1'))
    const { chmod } = await import('node:fs/promises')
    await chmod(filePath, 0o000)
    await appendFile(filePath, claudeLine('a-1', 'assistant', 'reply')).catch(() => {})
    // Give the watcher a chance to attempt (and fail) a drain.
    await new Promise((resolve) => setTimeout(resolve, 40))
    await chmod(filePath, 0o644)
    await appendFile(filePath, claudeLine('a-2', 'assistant', 'recovered'))

    await waitFor(() => seen.some((m) => m.id === 'a-2'))
    sub.unsubscribe()
    expect(seen.some((m) => m.id === 'a-2')).toBe(true)
  })

  it('releases the watcher on unsubscribe (no leak)', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'hi'))
    const before = getActiveNativeChatWatcherCount()

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: () => {},
      debounceMs: 5
    })
    expect(getActiveNativeChatWatcherCount()).toBe(before + 1)

    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(before)

    // Idempotent: a second unsubscribe must not under-count.
    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(before)
  })

  it('coalesces rapid successive appends without dropping messages', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'hi'))
    const seen: NativeChatMessage[] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 10
    })

    // Fire several appends back-to-back within the debounce window.
    await appendFile(filePath, claudeLine('a-1', 'assistant', 'one'))
    await appendFile(filePath, claudeLine('a-2', 'assistant', 'two'))
    await appendFile(filePath, claudeLine('a-3', 'assistant', 'three'))

    await waitFor(() => ['a-1', 'a-2', 'a-3'].every((id) => seen.some((m) => m.id === id)))
    sub.unsubscribe()

    // Order is preserved for the appended turns (the seed re-read may also carry
    // the pre-existing u-1, which the assembler dedups downstream).
    const appendedIds = seen.map((m) => m.id).filter((id) => id !== 'u-1')
    expect(appendedIds).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('waits for an incomplete trailing JSONL line before advancing the offset', async () => {
    const filePath = await tempFile(claudeLine('u-1', 'user', 'hi'))
    const seen: NativeChatMessage[] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })

    await waitFor(() => seen.some((m) => m.id === 'u-1'))

    const line = claudeLine('a-partial', 'assistant', 'split reply')
    const splitAt = Math.floor(line.length / 2)
    await appendFile(filePath, line.slice(0, splitAt))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(seen.some((m) => m.id === 'a-partial')).toBe(false)

    await appendFile(filePath, line.slice(splitAt))
    await waitFor(() => seen.some((m) => m.id === 'a-partial'))

    sub.unsubscribe()
    expect(seen.filter((m) => m.id === 'a-partial')).toHaveLength(1)
  })

  it('survives file replacement / rotation (offset reset on shrink)', async () => {
    const filePath = await tempFile(
      claudeLine('u-1', 'user', 'old') + claudeLine('a-1', 'assistant', 'old-reply')
    )
    const seen: NativeChatMessage[] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })

    // Replace the file with shorter content (simulates rotation to a new,
    // smaller session file at the same resolved path).
    await writeFile(filePath, claudeLine('u-2', 'user', 'fresh'))
    await waitFor(() => seen.some((m) => m.id === 'u-2'))

    // A subsequent append on the rotated file is still tailed.
    await appendFile(filePath, claudeLine('a-2', 'assistant', 'fresh-reply'))
    await waitFor(() => seen.some((m) => m.id === 'a-2'))

    sub.unsubscribe()
    const ids = seen.map((m) => m.id)
    expect(ids).toContain('u-2')
    expect(ids).toContain('a-2')
  })

  it('detects same-size and larger in-place transcript replacement', async () => {
    const filePath = await tempFile(claudeLine('u-old', 'user', 'old'))
    const seen: NativeChatMessage[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })
    await waitFor(() => seen.some((message) => message.id === 'u-old'))

    await writeFile(filePath, claudeLine('u-new', 'user', 'new'))
    await waitFor(() => seen.some((message) => message.id === 'u-new'))
    await writeFile(filePath, claudeLine('u-bigger', 'user', 'larger replacement text'))
    await waitFor(() => seen.some((message) => message.id === 'u-bigger'))
    sub.unsubscribe()

    expect(seen.filter((message) => message.id === 'u-new')).toHaveLength(1)
    expect(seen.filter((message) => message.id === 'u-bigger')).toHaveLength(1)
  })

  it('keeps watching after atomic rename replacement', async () => {
    const filePath = await tempFile(claudeLine('atomic-old', 'user', 'old'))
    const replacementPath = `${filePath}.replacement`
    const seen: NativeChatMessage[] = []
    const replacements: string[][] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      initialLimit: 40,
      onInitialSnapshot: (messages) => seen.push(...messages),
      onReplace: (messages) => {
        replacements.push(messages.map((message) => message.id))
        seen.splice(0, seen.length, ...messages)
      },
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5
    })
    await waitFor(() => seen.some((message) => message.id === 'atomic-old'))

    await writeFile(replacementPath, claudeLine('atomic-new', 'user', 'replacement'))
    await rename(replacementPath, filePath)
    await waitFor(() => seen.some((message) => message.id === 'atomic-new'))
    await appendFile(filePath, claudeLine('atomic-followup', 'assistant', 'still watched'))
    await waitFor(() => seen.some((message) => message.id === 'atomic-followup'))
    sub.unsubscribe()

    expect(replacements).toEqual([['atomic-new']])
    expect(seen.some((message) => message.id === 'atomic-old')).toBe(false)
    expect(seen.filter((message) => message.id === 'atomic-followup')).toHaveLength(1)
  })

  it('does not resurrect the watcher when unsubscribe races an atomic replacement', async () => {
    const filePath = await tempFile(claudeLine('race-old', 'user', 'old'))
    const replacementPath = `${filePath}.replacement`
    const before = getActiveNativeChatWatcherCount()
    const seen: NativeChatMessage[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 0
    })
    await waitFor(() => seen.some((message) => message.id === 'race-old'))

    await writeFile(replacementPath, claudeLine('race-new', 'user', 'replacement'))
    await rename(replacementPath, filePath)
    await new Promise((resolve) => setTimeout(resolve, 0))
    sub.unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(getActiveNativeChatWatcherCount()).toBe(before)
    await appendFile(filePath, claudeLine('race-after', 'assistant', 'must stay closed'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seen.some((message) => message.id === 'race-after')).toBe(false)
  })

  it('recovers after an unlink/recreate gap outlasts the fast retry window', async () => {
    const filePath = await tempFile(claudeLine('unlink-old', 'user', 'old'))
    const seen: NativeChatMessage[] = []
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 0
    })
    await waitFor(() => seen.some((message) => message.id === 'unlink-old'))

    await rm(filePath)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await writeFile(filePath, claudeLine('unlink-new', 'user', 'replacement'))
    await waitFor(() => seen.some((message) => message.id === 'unlink-new'))
    await appendFile(filePath, claudeLine('unlink-after', 'assistant', 'still watched'))
    await waitFor(() => seen.some((message) => message.id === 'unlink-after'))
    sub.unsubscribe()

    expect(seen.filter((message) => message.id === 'unlink-after')).toHaveLength(1)
  })

  it('returns a no-op unsubscribe when the file cannot be resolved', async () => {
    const before = getActiveNativeChatWatcherCount()
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: '',
      onAppend: () => {}
    })
    expect(sub.watching).toBe(false)
    expect(getActiveNativeChatWatcherCount()).toBe(before)
    // Must not throw.
    sub.unsubscribe()
  })
})

// Regression for #8401: Claude Code (and other agents) can take from ~3s to
// minutes to flush a brand-new session's first JSONL line, so the file
// genuinely doesn't exist when native chat subscribes. Before this fix,
// subscribeNativeChatTranscript returned a permanent no-op the instant the
// file was missing and never recovered once it appeared.
describe('subscribeNativeChatTranscript (resolve-poll for a not-yet-created file, #8401)', () => {
  it('keeps retrying resolve+install and tails the file once it is created', async () => {
    const filePath = await pendingFilePath()
    const seen: NativeChatMessage[] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => seen.push(...messages),
      debounceMs: 5,
      resolvePollIntervalMs: 20
    })

    // Nothing installed yet — the file doesn't exist on disk.
    expect(getActiveNativeChatWatcherCount()).toBe(0)

    // The agent flushes its first turn well after subscribe.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await writeFile(filePath, claudeLine('u-1', 'user', 'hello'))

    await waitFor(() => seen.some((m) => m.id === 'u-1'))
    expect(getActiveNativeChatWatcherCount()).toBe(1)

    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(0)
  })

  it('returns a no-op (no resolve poll) for a blank session id with no explicit file', async () => {
    const before = getActiveNativeChatWatcherCount()
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: '   ',
      onAppend: () => {},
      debounceMs: 5,
      resolvePollIntervalMs: 10
    })

    // An unresolvable target must not spin the resolve poll forever.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(getActiveNativeChatWatcherCount()).toBe(before)
    sub.unsubscribe()
    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(before)
  })

  it('unsubscribing during the poll phase leaves no watcher or timer alive', async () => {
    const filePath = await pendingFilePath()
    const before = getActiveNativeChatWatcherCount()

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: () => {},
      debounceMs: 5,
      resolvePollIntervalMs: 20
    })

    // Unsubscribe while still polling — the file is never created in this test.
    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(before)

    // Give any stray timer a chance to fire; it must not install a watcher.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(getActiveNativeChatWatcherCount()).toBe(before)
  })
})
