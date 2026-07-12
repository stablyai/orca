import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'

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

  it('returns a no-op unsubscribe when the file cannot be resolved', async () => {
    const before = getActiveNativeChatWatcherCount()
    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: '',
      onAppend: () => {}
    })
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
