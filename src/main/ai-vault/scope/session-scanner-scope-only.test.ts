import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../session-scanner'
import { isolatedScanRoots } from '../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeClaudeSession(args: {
  claudeRoot: string
  dirName: string
  sessionId: string
  cwd: string
  iso: string
  // Records before the first cwd, like a long run of snapshot or summary lines.
  cwdlessLines?: number
  // File time when it differs from the transcript's own time.
  mtime?: string
}): Promise<void> {
  const dir = join(args.claudeRoot, args.dirName)
  await mkdir(dir, { recursive: true })
  const records: unknown[] = Array.from({ length: args.cwdlessLines ?? 0 }, () => ({
    type: 'file-history-snapshot',
    sessionId: args.sessionId
  }))
  records.push({
    type: 'user',
    sessionId: args.sessionId,
    timestamp: args.iso,
    cwd: args.cwd,
    message: { role: 'user', content: `work in ${args.cwd}` }
  })
  const filePath = join(dir, `${args.sessionId}.jsonl`)
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
  const time = new Date(args.mtime ?? args.iso)
  await utimes(filePath, time, time)
}

// What main's Workspace tab shows: the full scan, filtered to the scope as the renderer does.

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-only-'))
  tempRoots.push(root)
  return root
}

describe('scanAiVaultSessions scopeOnly', () => {
  it('returns only in-scope rows', async () => {
    const root = await tempRoot()
    const claudeRoot = isolatedScanRoots(root).claudeProjectsDir
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'in-scope',
      cwd: '/repo/app',
      iso: '2026-06-01T00:00:00.000Z'
    })
    await writeClaudeSession({
      claudeRoot,
      dirName: '-elsewhere',
      sessionId: 'elsewhere',
      cwd: '/elsewhere',
      iso: '2026-06-02T00:00:00.000Z'
    })
    // Codex has no cwd buckets, so it still goes through the recency pass.
    const codexDir = join(isolatedScanRoots(root).codexSessionsDir, '2026', '06', '03')
    await mkdir(codexDir, { recursive: true })
    const codexId = '019e9693-64fc-7370-9c18-7e625c595d0f'
    await writeFile(
      join(codexDir, `rollout-2026-06-03T00-00-00-${codexId}.jsonl`),
      [
        {
          timestamp: '2026-06-03T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: codexId, cwd: '/elsewhere' }
        },
        {
          timestamp: '2026-06-03T00:00:01.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      platform: 'darwin',
      scopePaths: ['/repo/app'],
      scopeOnly: true
    })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['in-scope'])
  })
})
