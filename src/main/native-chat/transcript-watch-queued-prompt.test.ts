import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { subscribeNativeChatTranscript } from './transcript-watch'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const AT = (seconds: number): string => `2026-06-01T10:00:${String(seconds).padStart(2, '0')}.000Z`

function turn(uuid: string, role: 'user' | 'assistant', text: string, seconds: number): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: AT(seconds),
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}

/** Stamped when enqueued, appended only once the agent takes it. */
function queuedPrompt(uuid: string, text: string, enqueuedAt: number): string {
  return `${JSON.stringify({
    type: 'attachment',
    uuid,
    timestamp: AT(enqueuedAt),
    attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt' }
  })}\n`
}

async function tempFile(initial: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-queued-'))
  roots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, initial)
  return filePath
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('queued prompts arriving on the live tail', () => {
  // Why: the append batch holds only the queued record, so without the previous
  // batch's timestamp it would sort back above the reply already on screen.
  it('anchors a queued prompt that arrives alone, after the reply it followed', async () => {
    const filePath = await tempFile(turn('u1', 'user', 'first prompt', 0))
    const snapshots = vi.fn()
    const appended: NativeChatMessage[] = []

    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot: snapshots,
      onAppend: (messages) => appended.push(...messages),
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })
    await waitFor(() => snapshots.mock.calls.length === 1)

    await appendFile(filePath, turn('a1', 'assistant', 'reply to first', 30))
    await waitFor(() => appended.some((message) => message.id === 'a1'))

    await appendFile(filePath, queuedPrompt('q1', 'queued while busy', 10))
    await waitFor(() => appended.some((message) => message.id === 'q1'))

    subscription.unsubscribe()

    const reply = appended.find((message) => message.id === 'a1')
    const queued = appended.find((message) => message.id === 'q1')
    expect(queued?.blocks).toEqual([{ type: 'text', text: 'queued while busy' }])
    // Sorts after the reply it was appended behind, not back at its enqueue time.
    expect(queued?.timestamp).toBeGreaterThan(reply?.timestamp ?? 0)
    expect(queued?.timestamp).not.toBe(Date.parse(AT(10)))
  })
})
