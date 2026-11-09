import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { consumeCompleteJsonlLines } from '../../session-scanner-jsonl-reader'
import { isolatedScanRoots, jsonLines } from '../../session-scanner-test-fixtures'

const SESSION_ID = '019f0000-1111-7222-8333-444444444444'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function rolloutRecords(cwd: string, text: string): string {
  const lines = jsonLines([
    {
      timestamp: '2026-05-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: SESSION_ID, cwd }
    },
    {
      timestamp: '2026-05-01T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] }
    }
  ])
  return `${lines}\n`
}

describe('scanAiVaultSessions compressed Codex rollouts', () => {
  it('lists a rollout that exists only as .jsonl.zst', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const dir = join(roots.codexSessionsDir, '2026', '05', '01')
    const name = `rollout-2026-05-01T10-00-00-${SESSION_ID}.jsonl.zst`
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, name),
      zstdCompressSync(rolloutRecords('/repo/app', 'compressed only'))
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.filter((session) => session.agent === 'codex')).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        cwd: '/repo/app',
        filePath: join(dir, name)
      })
    ])
  })

  it('keeps the plain rollout when a newer compressed twin is beside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-twin-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const dir = join(roots.codexSessionsDir, '2026', '05', '01')
    const plainName = `rollout-2026-05-01T10-00-00-${SESSION_ID}.jsonl`
    const compressedName = `${plainName}.zst`
    await mkdir(dir, { recursive: true })
    const plainPath = join(dir, plainName)
    const compressedPath = join(dir, compressedName)
    await writeFile(plainPath, rolloutRecords('/repo/plain', 'plain copy'))
    await writeFile(
      compressedPath,
      zstdCompressSync(rolloutRecords('/repo/compressed', 'old copy'))
    )
    await utimes(plainPath, new Date('2026-05-01T10:00:00Z'), new Date('2026-05-01T10:00:00Z'))
    await utimes(compressedPath, new Date('2026-05-08T10:00:00Z'), new Date('2026-05-08T10:00:00Z'))

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    const codexSessions = result.sessions.filter((session) => session.agent === 'codex')

    expect(result.issues).toEqual([])
    expect(codexSessions).toHaveLength(1)
    expect(codexSessions[0]).toMatchObject({
      sessionId: SESSION_ID,
      cwd: '/repo/plain',
      filePath: plainPath
    })
  })

  it('resumes a compressed rollout from a decoded JSONL offset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-resume-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const dir = join(roots.codexSessionsDir, '2026', '05', '01')
    const path = join(dir, `rollout-2026-05-01T10-00-00-${SESSION_ID}.jsonl.zst`)
    const plain = rolloutRecords('/repo/app', 'second record')
    const start = plain.indexOf('\n') + 1
    await mkdir(dir, { recursive: true })
    await writeFile(path, zstdCompressSync(plain))

    const lines: string[] = []
    const read = await consumeCompleteJsonlLines({
      path,
      start,
      onLine: (line) => lines.push(line)
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('second record')
    expect(read.consumedThrough).toBe(Buffer.byteLength(plain))
  })
})
