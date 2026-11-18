import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeMuseUsagePersistedFiles } from './persisted-file-normalization'
import { scanMuseUsageFiles } from './scanner'

const RECORDED_AT_MICROS = 1_790_052_419_142_353

function modelCompleted(recordedAt: number, inputTokens: number, outputTokens: number) {
  return {
    recorded_at: recordedAt,
    payload_type: 'runtime.session',
    payload: {
      event: {
        kind: 'model_completed',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
      }
    }
  }
}

describe('scanMuseUsageFiles with a cached record missing its sessions', () => {
  let root: string
  let sessionsDir: string

  beforeEach(async () => {
    root = await realpath(mkdtempSync(join(tmpdir(), 'muse-usage-damaged-')))
    sessionsDir = join(root, 'sessions')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeSession(sessionId: string, records: Record<string, unknown>[]): string {
    const dir = join(sessionsDir, '2026', '09', '22', sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    return file
  }

  it('frees its claims for a fork once its log is deleted', async () => {
    const shared = modelCompleted(RECORDED_AT_MICROS, 100, 10)
    const owner = writeSession('a-owner', [shared])
    writeSession('b-fork', [shared, modelCompleted(RECORDED_AT_MICROS + 9, 5, 5)])
    const first = await scanMuseUsageFiles([], [], undefined, sessionsDir)

    rmSync(owner)
    const damaged = first.processedFiles.map((file) => {
      const copy = { ...file }
      if (file.path === owner) {
        Reflect.deleteProperty(copy, 'sessions')
      }
      return copy
    })
    const second = await scanMuseUsageFiles(
      [],
      normalizeMuseUsagePersistedFiles(damaged),
      undefined,
      sessionsDir
    )

    expect(second.sessions).toEqual([
      expect.objectContaining({ sessionId: 'b-fork', totalTokens: 120 })
    ])
  })
})
