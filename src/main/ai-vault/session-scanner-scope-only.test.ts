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

async function writeCodexSession(
  codexRoot: string,
  args: { id: string; cwd: string; iso: string; mtime: string }
): Promise<void> {
  const dir = join(codexRoot, '2026', '06', '01')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `rollout-2026-06-01T00-00-00-${args.id}.jsonl`)
  await writeFile(
    filePath,
    [
      { timestamp: args.iso, type: 'session_meta', payload: { id: args.id, cwd: args.cwd } },
      {
        timestamp: args.iso,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  )
  const time = new Date(args.mtime)
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

  it('matches buckets whose names use the other Unicode form', async () => {
    const root = await tempRoot()
    const cwd = '/repo/cafe\u0301'
    const dir = join(isolatedScanRoots(root).codebuddyProjectsDir, 'repo-cafe\u0301')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'nfd.jsonl'),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-01T00:00:00.000Z',
        sessionId: 'nfd',
        cwd,
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }]
      })
    )
    // Claude turns each non-alphanumeric code unit into a dash, so an NFD cwd names `-repo-cafe-`.
    await writeClaudeSession({
      claudeRoot: isolatedScanRoots(root).claudeProjectsDir,
      dirName: '-repo-cafe-',
      sessionId: 'claude-nfd',
      cwd,
      iso: '2026-06-02T00:00:00.000Z'
    })
    const scopePaths = [cwd.normalize('NFC')]

    const main = await workspaceSessionIds(root, scopePaths, {})
    expect(main).toEqual(['claude-nfd', 'nfd'])
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

  it('keeps in-scope rows when unverified files are newer than them', async () => {
    const root = await tempRoot()
    const claudeRoot = isolatedScanRoots(root).claudeProjectsDir
    const inScope = (sessionId: string, day: string) =>
      writeClaudeSession({
        claudeRoot,
        dirName: '-repo-app',
        sessionId,
        cwd: '/repo/app',
        iso: `2026-06-${day}T00:00:00.000Z`
      })
    await inScope('a1', '10')
    await inScope('a2', '09')
    // A sibling whose name also starts `-repo-app`, with cwds past the probe: its files must not take a3's or a4's slot.
    for (const [sessionId, day] of [
      ['web-1', '08'],
      ['web-2', '07']
    ]) {
      await writeClaudeSession({
        claudeRoot,
        dirName: '-repo-app-web',
        sessionId,
        cwd: '/repo/app-web',
        iso: `2026-06-${day}T00:00:00.000Z`,
        cwdlessLines: 250
      })
    }
    await inScope('a3', '05')
    await inScope('a4', '04')

    const main = await workspaceSessionIds(root, ['/repo/app'], { limit: 2 })
    expect(main).toEqual(['a1', 'a2', 'a3', 'a4'])
    await expect(
      workspaceSessionIds(root, ['/repo/app'], { limit: 2, scopeOnly: true })
    ).resolves.toEqual(main)
  })

  it('keeps recency rows whose transcript time is older than their file time', async () => {
    const root = await tempRoot()
    const codexRoot = isolatedScanRoots(root).codexSessionsDir
    // Newest file first: a group whose transcripts say they are old, ahead of newer-dated ones (imported logs).
    const groups: { cwd: string; mtimeDay: string; isoDay: string }[] = [
      { cwd: '/repo/app', mtimeDay: '20', isoDay: '02' },
      { cwd: '/elsewhere', mtimeDay: '18', isoDay: '10' },
      { cwd: '/repo/app', mtimeDay: '16', isoDay: '12' }
    ]
    let index = 0
    for (const group of groups) {
      for (let copy = 0; copy < 2; copy++) {
        await writeCodexSession(codexRoot, {
          id: `019e9693-64fc-7370-9c18-7e625c5950${index++}0`,
          cwd: group.cwd,
          iso: `2026-06-${group.isoDay}T0${copy}:00:00.000Z`,
          mtime: `2026-06-${group.mtimeDay}T0${copy}:00:00.000Z`
        })
      }
    }
    // Old Claude rows elsewhere with the newest files: main parses past them, scope-only never lists them.
    for (let copy = 0; copy < 2; copy++) {
      await writeClaudeSession({
        claudeRoot: isolatedScanRoots(root).claudeProjectsDir,
        dirName: '-elsewhere',
        sessionId: `claude-${copy}`,
        cwd: '/elsewhere',
        iso: `2026-01-0${copy + 1}T00:00:00.000Z`,
        mtime: `2026-06-2${copy + 2}T00:00:00.000Z`
      })
    }

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
