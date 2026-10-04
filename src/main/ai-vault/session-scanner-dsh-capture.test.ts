import { readFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseDshSessionBytes, parseDshSessionFile } from './session-scanner-dsh-parser'

// Actual official 0.2.0-rc.2 / 639ed015 capture; endpoint rejected generation with 401.
describe('sanitized actual DSH v4 persistence', () => {
  it('projects the real human prompt while excluding injected context and failed model attempts', async () => {
    const content = await readFile(
      new URL('./__fixtures__/dsh-v4-auth-rejected.jsonl', import.meta.url)
    )
    const rows = content.toString().split('\n').filter(Boolean)
    const frames = Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${row}\n`))))
    const session = await parseDshSessionBytes(
      {
        path: '/home/proof/.dsh/sessions/project/session-dsh-history-proof/session.v4.jsonl.zstd',
        mtimeMs: 1790920000000,
        modifiedAt: '2026-10-02T00:00:00.000Z'
      },
      (async function* () {
        yield frames
      })(),
      'linux'
    )
    expect(session?.sessionId).toBe('session-dsh-history-proof')
    expect(session?.model).toBe('deepseek-flash')
    expect(session?.messageCount).toBe(1)
    expect(session?.previewMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'DSH history proof: inspect this folder without generating an answer.'
      })
    ])
    expect(session?.totalTokens).toBe(0)
  })
  it.skipIf(!process.env.ORCA_REAL_DSH_HISTORY_FILE)(
    'reads the untouched official CLI artifact',
    async () => {
      const path = process.env.ORCA_REAL_DSH_HISTORY_FILE
      if (!path) {
        throw new Error('Set ORCA_REAL_DSH_HISTORY_FILE')
      }
      const session = await parseDshSessionFile(
        { path, mtimeMs: Date.now(), modifiedAt: new Date().toISOString() },
        process.platform
      )
      expect(session?.agent).toBe('dsh')
      expect(session?.messageCount).toBeGreaterThan(0)
      expect(session?.previewMessages.some((message) => message.role === 'user')).toBe(true)
      expect(session?.resumeCommand).toContain(session?.sessionId)
    }
  )
})
