import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import { openCodexRolloutStream } from './session-scanner-codex-rollout-read'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('Codex cold-compressed rollout scanning', () => {
  it('discovers and fully reparses updated .jsonl.zst sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '019f0000-1111-7222-8333-444444444444'
    const sessionPath = join(
      roots.codexSessionsDir,
      '2026',
      '06',
      '18',
      `rollout-2026-06-18T10-00-00-${sessionId}.jsonl.zst`
    )
    await mkdir(dirname(sessionPath), { recursive: true })

    const records = [
      {
        timestamp: '2026-06-18T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo/app' }
      },
      {
        timestamp: '2026-06-18T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'user_message',
            id: 'u1',
            content: [{ type: 'text', text: 'Compressed rollout prompt' }]
          }
        }
      }
    ]
    await writeFile(sessionPath, zstdCompressSync(Buffer.from(jsonLines(records), 'utf-8')))

    const first = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(first.issues).toEqual([])
    expect(first.sessions).toHaveLength(1)
    expect(first.sessions[0]).toMatchObject({
      sessionId,
      title: 'Compressed rollout prompt',
      messageCount: 1
    })

    records.push({
      timestamp: '2026-06-18T10:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'agent_message',
          id: 'a1',
          content: [{ type: 'text', text: 'Compressed reply' }]
        }
      }
    })
    await writeFile(sessionPath, zstdCompressSync(Buffer.from(jsonLines(records), 'utf-8')))

    const second = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(second.issues).toEqual([])
    expect(second.sessions[0]?.messageCount).toBe(2)
  })

  it('prefers a plain rollout over its compressed sibling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-sibling-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '019f0000-2222-7333-8444-555555555555'
    const basePath = join(
      roots.codexSessionsDir,
      '2026',
      '06',
      '18',
      `rollout-2026-06-18T10-00-00-${sessionId}.jsonl`
    )
    await mkdir(dirname(basePath), { recursive: true })
    const records = [
      {
        timestamp: '2026-06-18T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo/app' }
      }
    ]
    const content = jsonLines(records)
    await writeFile(`${basePath}.zst`, zstdCompressSync(Buffer.from(content, 'utf-8')))
    await writeFile(basePath, content)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.filePath).toBe(basePath)
  })

  it('selects plain siblings before applying the per-agent discovery limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-limit-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '019f0000-3333-7444-8555-666666666666'
    const basePath = join(
      roots.codexSessionsDir,
      '2026',
      '06',
      '18',
      `rollout-2026-06-18T10-00-00-${sessionId}.jsonl`
    )
    await mkdir(dirname(basePath), { recursive: true })
    const content = jsonLines([
      {
        timestamp: '2026-06-18T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo/app' }
      }
    ])
    await writeFile(basePath, content)
    await writeFile(`${basePath}.zst`, zstdCompressSync(Buffer.from(content, 'utf-8')))
    await utimes(basePath, new Date('2026-06-18T10:00:00.000Z'), new Date('2026-06-18T10:00:00.000Z'))
    await utimes(
      `${basePath}.zst`,
      new Date('2026-06-18T10:00:01.000Z'),
      new Date('2026-06-18T10:00:01.000Z')
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limitPerAgent: 1
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.filePath).toBe(basePath)
  })

  it('propagates missing and corrupt compressed rollout errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-errors-'))
    tempRoots.push(root)
    const missingPath = join(root, 'missing.jsonl.zst')
    await expect(
      parseCodexSessionFile({
        path: missingPath,
        mtimeMs: 0,
        modifiedAt: new Date(0).toISOString()
      })
    ).rejects.toThrow()

    const corruptPath = join(root, 'corrupt.jsonl.zst')
    await writeFile(corruptPath, 'not-zstd-data', 'utf-8')
    await expect(
      parseCodexSessionFile({
        path: corruptPath,
        mtimeMs: 0,
        modifiedAt: new Date(0).toISOString()
      })
    ).rejects.toThrow()
  })

  it('closes the complete compressed stream when a reader stops early', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-close-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'rollout.jsonl.zst')
    const content = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session' } })}\n`.repeat(
      10_000
    )
    await writeFile(sessionPath, zstdCompressSync(Buffer.from(content, 'utf-8')))

    const stream = openCodexRolloutStream(sessionPath)
    const closed = new Promise<void>((resolve) => stream.once('close', resolve))
    // `compose().destroy()` reports an expected AbortError while closing the
    // owned pipeline; a consumer may intentionally stop before EOF.
    stream.once('error', () => undefined)
    stream.destroy()
    await closed

    expect(stream.destroyed).toBe(true)
  })
})
