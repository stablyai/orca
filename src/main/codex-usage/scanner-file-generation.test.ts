import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as JsonlLineOffsets from '../usage/jsonl-line-offsets'

const fixture = vi.hoisted(() => {
  const parseOffsets: number[] = []
  return { root: '', parseOffsets }
})

vi.mock('../codex/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => join(fixture.root, 'runtime'),
  getSystemCodexHomePath: () => join(fixture.root, 'system')
}))

vi.mock('../codex/codex-account-home-discovery', () => ({
  getCodexAccountHomeSessionDirectories: () => []
}))

vi.mock('../codex/codex-session-bridge', () => ({
  getLegacyCopiedCodexSessionBridgeScanPreference: () => null
}))

vi.mock('../usage/jsonl-line-offsets', async () => {
  const actual = await vi.importActual<typeof JsonlLineOffsets>('../usage/jsonl-line-offsets')
  return {
    ...actual,
    readJsonlLinesFromOffset: async function* (
      ...args: Parameters<typeof actual.readJsonlLinesFromOffset>
    ) {
      fixture.parseOffsets.push(args[1])
      yield* actual.readJsonlLinesFromOffset(...args)
    }
  }
})

import { scanCodexUsageFiles } from './scanner'

const preservedMtime = new Date('2026-05-26T12:00:00.000Z')
let rolloutPath: string

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'orca-codex-file-generation-'))
  const sessions = join(fixture.root, 'runtime', 'sessions')
  mkdirSync(sessions, { recursive: true })
  rolloutPath = join(sessions, 'rollout.jsonl')
  fixture.parseOffsets.length = 0
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

function transcript(sessionId: string, count: number, changedIndex = -1): string {
  const metadata = JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, cwd: fixture.root }
  })
  const records = Array.from({ length: count }, (_, index) => {
    const tokens = index === changedIndex ? 20 : 10
    return JSON.stringify({
      timestamp: new Date(preservedMtime.getTime() + index * 60_000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: { input_tokens: tokens, total_tokens: tokens }
        }
      }
    })
  })
  return `${[metadata, ...records].join('\n')}\n`
}

function writePreservingMtime(filePath: string, content: string): void {
  writeFileSync(filePath, content)
  utimesSync(filePath, preservedMtime, preservedMtime)
}

function totalTokens(rows: { totalTokens: number }[]): number {
  return rows.reduce((sum, row) => sum + row.totalTokens, 0)
}

describe('Codex cached rollout generation', () => {
  it.each([1, 80])(
    'reparses a same-size preserved-mtime atomic replacement containing %i events',
    async (count) => {
      const original = transcript('session-old', count)
      const replacement = transcript('session-new', count, Math.floor(count / 2))
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
      writePreservingMtime(rolloutPath, original)
      const before = statSync(rolloutPath, { bigint: true })
      const first = await scanCodexUsageFiles([], [])
      expect(totalTokens(first.dailyAggregates)).toBe(count * 10)
      expect(Boolean(first.processedFiles[0]?.parseResumeState)).toBe(count > 1)

      const replacementPath = join(fixture.root, 'replacement.jsonl')
      writePreservingMtime(replacementPath, replacement)
      renameSync(replacementPath, rolloutPath)
      const after = statSync(rolloutPath, { bigint: true })
      expect(after.size).toBe(before.size)
      expect(after.mtimeNs).toBe(before.mtimeNs)
      if (before.ino !== 0n && after.ino !== 0n) {
        expect(`${after.dev}:${after.ino}`).not.toBe(`${before.dev}:${before.ino}`)
      }
      fixture.parseOffsets.length = 0

      const second = await scanCodexUsageFiles([], first.processedFiles)
      expect(totalTokens(second.dailyAggregates)).toBe(count * 10 + 10)
      expect(second.sessions[0]?.sessionId).toBe('session-new')
      expect(fixture.parseOffsets).toEqual([0])
      const cold = await scanCodexUsageFiles([], [])
      expect(second.sessions).toEqual(cold.sessions)
      expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
      fixture.parseOffsets.length = 0
      const third = await scanCodexUsageFiles([], second.processedFiles)
      expect(third.processedFiles[0]).toBe(second.processedFiles[0])
      expect(fixture.parseOffsets).toEqual([])
    }
  )

  it('cold-reparses a same-inode middle rewrite when size and mtime are preserved', async () => {
    const original = transcript('session-stable', 80)
    const replacement = transcript('session-stable', 80, 40)
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    expect(replacement.slice(0, 4096)).toBe(original.slice(0, 4096))
    expect(replacement.slice(-4096)).toBe(original.slice(-4096))
    writePreservingMtime(rolloutPath, original)
    const before = statSync(rolloutPath)
    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(800)
    expect(first.processedFiles[0]?.parseResumeState?.parsedBytes).toBe(before.size)

    await new Promise((resolve) => setTimeout(resolve, 20))
    writePreservingMtime(rolloutPath, replacement)
    const after = statSync(rolloutPath)
    expect(after.ino).toBe(before.ino)
    expect(after.dev).toBe(before.dev)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ctimeMs).not.toBe(before.ctimeMs)
    expect(readFileSync(rolloutPath, 'utf8')).toBe(replacement)
    fixture.parseOffsets.length = 0

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(810)
    expect(fixture.parseOffsets).toEqual([0])
    expect(second.processedFiles[0]?.ctimeMs).toBe(after.ctimeMs)
    const cold = await scanCodexUsageFiles([], [])
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
  })

  it('cold-reparses legacy metadata once even when the old checkpoint remains valid', async () => {
    writePreservingMtime(rolloutPath, transcript('session-legacy', 80))
    const first = await scanCodexUsageFiles([], [])
    expect(first.processedFiles[0]?.parseResumeState?.parsedBytes).toBeGreaterThan(12_288)
    const legacy = first.processedFiles.map((file) => {
      const oldFile = { ...file }
      delete oldFile.physicalFileId
      delete oldFile.ctimeMs
      return oldFile
    })
    fixture.parseOffsets.length = 0

    const second = await scanCodexUsageFiles([], legacy)
    expect(fixture.parseOffsets).toEqual([0])
    expect(second.sessions).toEqual(first.sessions)
    expect(second.dailyAggregates).toEqual(first.dailyAggregates)
    const stats = statSync(rolloutPath)
    expect(second.processedFiles[0]?.physicalFileId).toBe(
      stats.ino === 0 ? null : `${stats.dev}:${stats.ino}`
    )
    expect(second.processedFiles[0]?.ctimeMs).toBe(stats.ctimeMs)
    fixture.parseOffsets.length = 0

    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(third.processedFiles[0]).toBe(second.processedFiles[0])
    expect(fixture.parseOffsets).toEqual([])
  })
})
