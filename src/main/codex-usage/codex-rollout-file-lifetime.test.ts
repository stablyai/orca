import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexUsageFile } from './codex-rollout-file-parse'

const { openedHandles, closedHandles, failNextClose } = vi.hoisted(() => ({
  openedHandles: new Array<NodeFsPromises.FileHandle>(),
  closedHandles: new Set<NodeFsPromises.FileHandle>(),
  failNextClose: { current: false }
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      openedHandles.push(handle)
      const closeHandle = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        if (failNextClose.current) {
          failNextClose.current = false
          throw new Error('descriptor close failed')
        }
        await closeHandle()
        closedHandles.add(handle)
      })
      return handle
    }
  }
})

function rollout(sessionId: string, recordCount: number): string {
  const records = [JSON.stringify({ type: 'session_meta', payload: { id: sessionId } })]
  for (let index = 0; index < recordCount; index++) {
    records.push(
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 4, 26, 12, index)).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5-codex',
            last_token_usage: { input_tokens: 1, total_tokens: 1 },
            total_token_usage: { input_tokens: index + 1, total_tokens: index + 1 }
          }
        }
      })
    )
  }
  return `${records.join('\n')}\n`
}

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-codex-rollout-lifetime-'))
  openedHandles.length = 0
  closedHandles.clear()
  failNextClose.current = false
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('Codex rollout descriptor lifetime', () => {
  it.each([3, 100])(
    'closes the verified %i-record rollout before publishing ownership',
    async (recordCount) => {
      const rolloutPath = join(directory, 'rollout.jsonl')
      const replacementPath = join(directory, 'replacement.tmp')
      writeFileSync(rolloutPath, rollout('verified-session', recordCount))
      const originalStat = statSync(rolloutPath, { bigint: true })
      writeFileSync(replacementPath, rollout('replacement-session', 2))
      let committedKeys = 0

      const verified = await parseCodexUsageFile(rolloutPath, () => null, {
        commitEventKey: () => {
          expect(closedHandles.size).toBe(openedHandles.length)
          expect(openedHandles.every((handle) => handle.fd === -1)).toBe(true)
          if (committedKeys++ === 0) {
            renameSync(replacementPath, rolloutPath)
          }
        }
      })

      expect(committedKeys).toBe(recordCount)
      expect(verified.sessions.map(({ sessionId, eventCount }) => [sessionId, eventCount])).toEqual(
        [['verified-session', recordCount]]
      )
      expect(verified.size).toBe(Number(originalStat.size))
      expect(verified.physicalFileId).toBe(
        originalStat.ino === 0n ? null : `${originalStat.dev}:${originalStat.ino}`
      )
      expect(verified.parseResumeState !== null).toBe(recordCount === 100)
      const refreshed = await parseCodexUsageFile(
        rolloutPath,
        () => null,
        verified.parseResumeState
          ? { resume: { state: verified.parseResumeState, previous: verified } }
          : {}
      )
      expect(
        refreshed.sessions.map(({ sessionId, eventCount }) => [sessionId, eventCount])
      ).toEqual([['replacement-session', 2]])
      expect(closedHandles.size).toBe(openedHandles.length)
    }
  )

  it('keeps the descriptor closed when publishing ownership fails', async () => {
    const rolloutPath = join(directory, 'rollout.jsonl')
    writeFileSync(rolloutPath, rollout('failed-claims', 3))

    await expect(
      parseCodexUsageFile(rolloutPath, () => null, {
        commitEventKey: () => {
          expect(closedHandles.size).toBe(openedHandles.length)
          throw new Error('ownership publication failed')
        }
      })
    ).rejects.toThrow('ownership publication failed')
    expect(openedHandles).toHaveLength(1)
    expect(closedHandles.size).toBe(1)
    expect(openedHandles[0]?.fd).toBe(-1)
  })

  it('publishes no ownership if closing the verified descriptor fails', async () => {
    const rolloutPath = join(directory, 'rollout.jsonl')
    writeFileSync(rolloutPath, rollout('close-failure', 3))
    const commitEventKey = vi.fn()
    failNextClose.current = true

    await expect(parseCodexUsageFile(rolloutPath, () => null, { commitEventKey })).rejects.toThrow(
      'descriptor close failed'
    )
    expect(commitEventKey).not.toHaveBeenCalled()
    expect(openedHandles).toHaveLength(1)
    expect(closedHandles.size).toBe(1)
    expect(openedHandles[0]?.fd).toBe(-1)
  })
})
