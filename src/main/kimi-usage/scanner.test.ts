import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attributeKimiUsageEvent,
  getKimiUsageProcessedFileInfo,
  parseKimiUsageFile,
  parseKimiWireForUsage
} from './scanner'
import type { KimiUsageWorktreeRef } from './scanner'
const SESSION_ID = 'session_test-uuid'
function makeWorktrees(): (KimiUsageWorktreeRef & { canonicalPath: string })[] {
  return [
    {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/workspace/repo',
      path: '/workspace/repo',
      displayName: 'Repo',
      canonicalPath: '/workspace/repo'
    }
  ]
}
function makeUsageRecord(
  inputOther: number,
  output: number,
  inputCacheRead = 0,
  inputCacheCreation = 0,
  model = 'bigmodel/glm-5.2',
  time = 1785466212672
): string {
  return JSON.stringify({
    type: 'usage.record',
    model,
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    usageScope: 'turn',
    time
  })
}
function makeConfigUpdate(modelAlias: string): string {
  return JSON.stringify({ type: 'config.update', modelAlias, thinkingLevel: 'high' })
}
function makeSessionScopedRecord(): string {
  return JSON.stringify({
    type: 'usage.record',
    model: 'bigmodel/glm-5.2',
    usage: { inputOther: 999999, output: 999999, inputCacheRead: 0, inputCacheCreation: 0 },
    usageScope: 'session',
    time: 1785466212672
  })
}
describe('parseKimiWireForUsage', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-kimi-usage-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })
  it('extracts per-turn usage records', async () => {
    const wirePath = join(tempDir, 'wire.jsonl')
    writeFileSync(
      wirePath,
      [
        JSON.stringify({ type: 'metadata', protocol_version: '1.4' }),
        makeConfigUpdate('bigmodel/glm-5.2'),
        makeUsageRecord(100, 50, 200, 10),
        makeUsageRecord(300, 80, 0, 0, 'bigmodel/glm-5.2', 1785466220000)
      ].join('\n')
    )
    const events = await parseKimiWireForUsage(wirePath, SESSION_ID)
    expect(events).toHaveLength(2)
    expect(events[0].inputTokens).toBe(100)
    expect(events[0].outputTokens).toBe(50)
    expect(events[0].cachedInputTokens).toBe(200)
    expect(events[0].cacheCreationTokens).toBe(10)
    expect(events[0].model).toBe('bigmodel/glm-5.2')
    expect(events[0].totalTokens).toBe(360)
  })
  it('skips session-scoped cumulative records', async () => {
    const wirePath = join(tempDir, 'wire.jsonl')
    writeFileSync(
      wirePath,
      [
        makeUsageRecord(100, 50),
        makeSessionScopedRecord(),
        makeUsageRecord(200, 30, 0, 0, 'bigmodel/glm-5.2', 1785466220000)
      ].join('\n')
    )
    const events = await parseKimiWireForUsage(wirePath, SESSION_ID)
    expect(events).toHaveLength(2)
    // Session record (999999 each) must not appear
    const totalInput = events.reduce((sum, e) => sum + e.inputTokens, 0)
    expect(totalInput).toBe(300)
  })
  it('carries model from config.update into subsequent records', async () => {
    const wirePath = join(tempDir, 'wire.jsonl')
    writeFileSync(
      wirePath,
      [
        makeConfigUpdate('custom-model'),
        JSON.stringify({
          type: 'usage.record',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
          usageScope: 'turn',
          time: 1785466212672
        })
      ].join('\n')
    )
    const events = await parseKimiWireForUsage(wirePath, SESSION_ID)
    expect(events).toHaveLength(1)
    expect(events[0].model).toBe('custom-model')
  })
  it('skips records with zero tokens', async () => {
    const wirePath = join(tempDir, 'wire.jsonl')
    writeFileSync(wirePath, [makeUsageRecord(0, 0, 0, 0), makeUsageRecord(10, 5)].join('\n'))
    const events = await parseKimiWireForUsage(wirePath, SESSION_ID)
    expect(events).toHaveLength(1)
    expect(events[0].inputTokens).toBe(10)
  })
  it('handles malformed lines gracefully', async () => {
    const wirePath = join(tempDir, 'wire.jsonl')
    writeFileSync(
      wirePath,
      [
        'not json',
        makeUsageRecord(10, 5),
        '{type: "broken"',
        makeUsageRecord(20, 10, 0, 0, 'bigmodel/glm-5.2', 1785466220000)
      ].join('\n')
    )
    const events = await parseKimiWireForUsage(wirePath, SESSION_ID)
    expect(events).toHaveLength(2)
  })
  it('returns empty array when wire.jsonl does not exist', async () => {
    const events = await parseKimiWireForUsage(join(tempDir, 'nonexistent.jsonl'), SESSION_ID)
    expect(events).toEqual([])
  })
  it('prefers record.model over config.update modelAlias', async () => {
    const wirePath = join(tempDir, 'wire.jsonl')
    writeFileSync(
      wirePath,
      [
        makeConfigUpdate('alias-model'),
        JSON.stringify({
          type: 'usage.record',
          model: 'explicit-model',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
          usageScope: 'turn',
          time: 1785466212672
        })
      ].join('\n')
    )
    const events = await parseKimiWireForUsage(wirePath, SESSION_ID)
    expect(events[0].model).toBe('explicit-model')
  })
})
describe('attributeKimiUsageEvent', () => {
  it('attributes to a containing worktree', async () => {
    const event = {
      sessionId: SESSION_ID,
      timestamp: '2026-07-31T03:00:00.000Z',
      eventKey: 'key-1',
      model: 'bigmodel/glm-5.2',
      cwd: '/workspace/repo/src',
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
      totalTokens: 150
    }
    const attributed = await attributeKimiUsageEvent(event, makeWorktrees())
    expect(attributed).not.toBeNull()
    expect(attributed!.worktreeId).toBe('repo-1::/workspace/repo')
    expect(attributed!.repoId).toBe('repo-1')
    expect(attributed!.projectLabel).toBe('Repo')
  })
  it('falls back to cwd-based project key when not in a worktree', async () => {
    const event = {
      sessionId: SESSION_ID,
      timestamp: '2026-07-31T03:00:00.000Z',
      eventKey: 'key-1',
      model: 'bigmodel/glm-5.2',
      cwd: '/home/user/projects/myapp',
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
      totalTokens: 150
    }
    const attributed = await attributeKimiUsageEvent(event, makeWorktrees())
    expect(attributed).not.toBeNull()
    expect(attributed!.worktreeId).toBeNull()
    expect(attributed!.projectKey).toContain('cwd:')
  })
  it('returns null for invalid timestamp', async () => {
    const event = {
      sessionId: SESSION_ID,
      timestamp: 'not-a-date',
      eventKey: 'key-1',
      model: null,
      cwd: null,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
      totalTokens: 150
    }
    const attributed = await attributeKimiUsageEvent(event, makeWorktrees())
    expect(attributed).toBeNull()
  })
})

describe('parseKimiUsageFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-kimi-usage-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeSession(statePath: string, wireLines: string[]): void {
    mkdirSync(dirname(statePath), { recursive: true })
    mkdirSync(join(dirname(statePath), 'agents', 'main'), { recursive: true })
    writeFileSync(
      statePath,
      JSON.stringify({
        createdAt: '2026-07-31T03:00:00.000Z',
        updatedAt: '2026-07-31T03:01:00.000Z',
        title: 'Test',
        agents: { main: { type: 'main', parentAgentId: null } }
      })
    )
    writeFileSync(join(dirname(statePath), 'agents', 'main', 'wire.jsonl'), wireLines.join('\n'))
  }

  it('respects claimEventKey to deduplicate events', async () => {
    const statePath = join(tempDir, 'sessions', 'wd_test_abc', SESSION_ID, 'state.json')
    writeSession(statePath, [
      JSON.stringify({ type: 'config.update', modelAlias: 'glm-5.2' }),
      makeUsageRecord(100, 50),
      makeUsageRecord(200, 30, 0, 0, 'glm-5.2', 1785466220000)
    ])

    const claimed = new Set<string>()
    const result = await parseKimiUsageFile(statePath, [], {
      claimEventKey: (key) => {
        if (claimed.has(key)) {
          return false
        }
        claimed.add(key)
        return true
      }
    })

    // Both events should be claimed
    expect(result.ownedEventKeys).toHaveLength(2)
    expect(result.hasDeferredClaims).toBe(false)
  })

  it('sets hasDeferredClaims when claimEventKey rejects', async () => {
    const statePath = join(tempDir, 'sessions', 'wd_test_abc', SESSION_ID, 'state.json')
    writeSession(statePath, [
      JSON.stringify({ type: 'config.update', modelAlias: 'glm-5.2' }),
      makeUsageRecord(100, 50),
      makeUsageRecord(200, 30, 0, 0, 'glm-5.2', 1785466220000)
    ])

    // Pre-claim the first event so it gets rejected
    let rejectNext = true
    const result = await parseKimiUsageFile(statePath, [], {
      claimEventKey: () => {
        if (rejectNext) {
          rejectNext = false
          return false
        }
        return true
      }
    })

    expect(result.hasDeferredClaims).toBe(true)
    // Only one event was owned
    expect(result.ownedEventKeys).toHaveLength(1)
  })

  it('includes wire.jsonl identity in processed file info', async () => {
    const statePath = join(tempDir, 'sessions', 'wd_test_abc', SESSION_ID, 'state.json')
    const wirePath = join(dirname(statePath), 'agents', 'main', 'wire.jsonl')
    writeSession(statePath, [makeUsageRecord(100, 50)])

    const before = await getKimiUsageProcessedFileInfo(statePath)
    writeFileSync(
      wirePath,
      [makeUsageRecord(100, 50), makeUsageRecord(20, 10, 0, 0, 'glm-5.2', 1785466220000)].join('\n')
    )
    const after = await getKimiUsageProcessedFileInfo(statePath)

    expect(after.wirePath).toBe(wirePath)
    expect(after.wireSize).toBeGreaterThan(before.wireSize ?? 0)
    expect(after.wireMtimeMs).not.toBeNull()
  })
})
