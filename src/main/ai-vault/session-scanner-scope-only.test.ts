import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import {
  aiVaultSessionInScope,
  createAiVaultScopeCwdMatcher
} from '../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'

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
  const time = new Date(args.iso)
  await utimes(filePath, time, time)
}

// What main's Workspace tab shows: the full scan, filtered to the scope as the renderer does.
async function workspaceSessionIds(
  root: string,
  scopePaths: string[],
  options: { scopeOnly?: boolean; limit?: number }
): Promise<string[]> {
  const result = await scanAiVaultSessions({
    ...isolatedScanRoots(root),
    platform: 'darwin',
    scopePaths,
    ...options
  })
  const inScope = createAiVaultScopeCwdMatcher(scopePaths)
  return result.sessions
    .filter((session) => aiVaultSessionInScope(inScope, session))
    .map((session) => session.sessionId)
    .sort()
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-only-'))
  tempRoots.push(root)
  return root
}

describe('scanAiVaultSessions scopeOnly', () => {
  it('keeps recent sessions whose bucket or first lines name no in-scope cwd', async () => {
    const root = await tempRoot()
    const claudeRoot = isolatedScanRoots(root).claudeProjectsDir
    // The bucket's only transcript records its cwd after the 200 lines the bucket probe reads.
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'late-cwd',
      cwd: '/repo/app',
      iso: '2026-06-01T00:00:00.000Z',
      cwdlessLines: 250
    })
    // `/repo/my-app` and `/repo/my/app` share one bucket name; the newest transcript is the other folder's.
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-my-app',
      sessionId: 'shared-bucket',
      cwd: '/repo/my/app',
      iso: '2026-06-02T00:00:00.000Z'
    })
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-my-app',
      sessionId: 'other-folder',
      cwd: '/repo/my-app',
      iso: '2026-06-03T00:00:00.000Z'
    })
    // CodeBuddy's transcripts are checked one by one; this one also records its cwd late.
    const codebuddyDir = join(isolatedScanRoots(root).codebuddyProjectsDir, 'repo-app')
    await mkdir(codebuddyDir, { recursive: true })
    await writeFile(
      join(codebuddyDir, 'codebuddy-late-cwd.jsonl'),
      [
        ...Array.from({ length: 250 }, () => ({ type: 'file-history-snapshot' })),
        {
          type: 'message',
          timestamp: '2026-06-04T00:00:00.000Z',
          sessionId: 'codebuddy-late-cwd',
          cwd: '/repo/app',
          role: 'user',
          content: [{ type: 'input_text', text: 'work in /repo/app' }]
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )
    const scopePaths = ['/repo/app', '/repo/my/app']

    const main = await workspaceSessionIds(root, scopePaths, {})
    expect(main).toEqual(['codebuddy-late-cwd', 'late-cwd', 'shared-bucket'])
    await expect(workspaceSessionIds(root, scopePaths, { scopeOnly: true })).resolves.toEqual(main)
  })

  it('keeps every in-scope session main shows when the scope holds more than the limit', async () => {
    const root = await tempRoot()
    const claudeRoot = isolatedScanRoots(root).claudeProjectsDir
    for (let index = 0; index < 4; index++) {
      await writeClaudeSession({
        claudeRoot,
        dirName: '-repo-app',
        sessionId: `in-scope-${index}`,
        cwd: '/repo/app',
        iso: `2026-06-0${index + 1}T00:00:00.000Z`
      })
    }

    // Main shows the recency pass's 2 plus the scope pass's 2 more.
    const main = await workspaceSessionIds(root, ['/repo/app'], { limit: 2 })
    expect(main).toHaveLength(4)
    await expect(
      workspaceSessionIds(root, ['/repo/app'], { limit: 2, scopeOnly: true })
    ).resolves.toEqual(main)
  })

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

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      platform: 'darwin',
      scopePaths: ['/repo/app'],
      scopeOnly: true
    })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['in-scope'])
  })
})
