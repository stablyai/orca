import { writeFileSync } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'

function record(id: string, text: string): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: id,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role: 'user', content: text }
  })}\n`
}

it.each(['append', 'initial snapshot', 'replacement snapshot'] as const)(
  'delivers a larger rewrite while publishing a completed %s',
  async (mode) => {
    const before = getActiveNativeChatWatcherCount()
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-drain-race-'))
    const filePath = join(root, 'rollout.jsonl')
    const seen: string[] = []
    let stop = (): void => {}
    try {
      await writeFile(filePath, record('old', 'old'))
      const publish = (messages: NativeChatMessage[]): void => {
        seen.push(...messages.map((message) => message.id))
        if (messages.some((message) => message.id === 'old')) {
          writeFileSync(
            filePath,
            record(
              mode === 'replacement snapshot' ? 'middle' : 'new',
              'a larger replacement transcript'
            )
          )
        }
        if (messages.some((message) => message.id === 'middle')) {
          writeFileSync(filePath, record('new', 'a second still larger replacement transcript'))
        }
      }
      const sub = await subscribeNativeChatTranscript({
        agent: 'claude',
        sessionId: 'ignored',
        filePath,
        debounceMs: 0,
        reconciliationIntervalMs: 20,
        initialLimit: mode === 'append' ? undefined : 50,
        onAppend: publish,
        ...(mode === 'initial snapshot' ? { onInitialSnapshot: publish } : {}),
        ...(mode === 'replacement snapshot' ? { onReplace: publish } : {})
      })
      stop = sub.unsubscribe
      await expect.poll(() => seen, { timeout: 1_000 }).toContain('new')
      await appendFile(filePath, record('followup', 'normal append'))
      await expect.poll(() => seen, { timeout: 1_000 }).toContain('followup')
      expect(seen.filter((id) => id === 'new')).toHaveLength(1)
      expect(seen.filter((id) => id === 'followup')).toHaveLength(1)
    } finally {
      stop()
      await rm(root, { recursive: true, force: true })
      expect(getActiveNativeChatWatcherCount()).toBe(before)
    }
  }
)
