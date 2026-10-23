import { utimesSync, writeFileSync } from 'node:fs'
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

it.each([
  'append',
  'initial snapshot',
  'replacement snapshot',
  'metadata-only replacement replay'
] as const)('delivers a larger rewrite while publishing a completed %s', async (mode) => {
  const before = getActiveNativeChatWatcherCount()
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-drain-race-'))
  const filePath = join(root, 'rollout.jsonl')
  const seen: string[] = []
  const appendDeliveries: string[] = []
  let newReplacementCount = 0
  const usesReplacement =
    mode === 'replacement snapshot' || mode === 'metadata-only replacement replay'
  let stop = (): void => {}
  try {
    await writeFile(filePath, record('old', 'old'))
    const publish = (messages: NativeChatMessage[], replacement: boolean): void => {
      const ids = messages.map((message) => message.id)
      if (replacement) {
        // Full snapshots replace the client's view and may replay an existing message.
        seen.splice(0, seen.length, ...ids)
      } else {
        seen.push(...ids)
        appendDeliveries.push(...ids)
      }
      if (messages.some((message) => message.id === 'old')) {
        writeFileSync(
          filePath,
          record(usesReplacement ? 'middle' : 'new', 'a larger replacement transcript')
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
      onAppend: (messages) => publish(messages, false),
      ...(mode === 'initial snapshot'
        ? { onInitialSnapshot: (messages) => publish(messages, true) }
        : {}),
      ...(usesReplacement
        ? {
            onReplace: (messages) => {
              if (messages.some((message) => message.id === 'new')) {
                newReplacementCount += 1
              }
              publish(messages, true)
            }
          }
        : {})
    })
    stop = sub.unsubscribe
    await expect.poll(() => seen, { timeout: 1_000 }).toContain('new')
    if (mode === 'metadata-only replacement replay') {
      const beforeReplay = newReplacementCount
      expect(beforeReplay).toBeGreaterThanOrEqual(1)
      const updated = new Date(Date.now() + 2_000)
      utimesSync(filePath, updated, updated)
      await expect.poll(() => newReplacementCount, { timeout: 1_000 }).toBeGreaterThan(beforeReplay)
      expect(seen).toEqual(['new'])
      expect(appendDeliveries).not.toContain('new')
    }
    await appendFile(filePath, record('followup', 'normal append'))
    await expect.poll(() => seen, { timeout: 1_000 }).toContain('followup')
    expect(seen.filter((id) => id === 'new')).toHaveLength(1)
    expect(seen.filter((id) => id === 'followup')).toHaveLength(1)
    expect(appendDeliveries.filter((id) => id === 'new')).toHaveLength(usesReplacement ? 0 : 1)
    expect(appendDeliveries.filter((id) => id === 'followup').length).toBeLessThanOrEqual(1)
  } finally {
    stop()
    await rm(root, { recursive: true, force: true })
    expect(getActiveNativeChatWatcherCount()).toBe(before)
  }
})
