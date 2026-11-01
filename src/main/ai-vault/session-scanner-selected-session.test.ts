import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

it('retains one exact old selected transcript beyond 500 newer discoveries without widening history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-selected-history-'))
  try {
    const roots = isolatedScanRoots(root)
    const selectedPath = join(roots.claudeProjectsDir, 'old.jsonl')
    await writeJsonlFile(selectedPath, [
      {
        type: 'user',
        sessionId: 'old',
        message: { role: 'user', content: 'Old selected conversation' }
      }
    ])
    await utimes(selectedPath, new Date('2025-01-01'), new Date('2025-01-01'))
    await Promise.all(
      Array.from({ length: 501 }, async (_, index) => {
        const path = join(roots.claudeProjectsDir, `new-${index}.jsonl`)
        await writeJsonlFile(path, [
          {
            type: 'user',
            sessionId: `new-${index}`,
            message: { role: 'user', content: 'New conversation' }
          }
        ])
      })
    )
    const selectedSessionId = `local:claude:old:${selectedPath}`
    const options = { ...roots, limit: 500, limitPerAgent: 500 }
    const normal = await scanAiVaultSessions(options)
    expect(normal.sessions).toHaveLength(500)
    expect(normal.sessions.some((session) => session.id === selectedSessionId)).toBe(false)
    const selected = await scanAiVaultSessions({ ...options, selectedSessionId })
    expect(selected.sessions).toHaveLength(501)
    expect(selected.sessions.filter((session) => session.id === selectedSessionId)).toHaveLength(1)
    const wrongIdentity = await scanAiVaultSessions({
      ...options,
      selectedSessionId: `local:claude:wrong:${selectedPath}`
    })
    expect(wrongIdentity.sessions).toHaveLength(500)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
