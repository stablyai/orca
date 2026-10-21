import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { resetProjectDirCwdCacheForTests } from './session-scanner-scope-discovery'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  resetProjectDirCwdCacheForTests()
})

function codebuddySessionDirName(cwd: string): string {
  return cwd
    .replace(/[/\\:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

async function writeCodeBuddySession(args: {
  sessionsDir: string
  cwd: string
  id: string
  timestamp: string
}): Promise<void> {
  const dir = join(args.sessionsDir, codebuddySessionDirName(args.cwd))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${args.id}.jsonl`)
  await writeFile(
    file,
    jsonLines([
      {
        type: 'message',
        timestamp: args.timestamp,
        sessionId: args.id,
        cwd: args.cwd,
        role: 'user',
        content: [{ type: 'input_text', text: `prompt ${args.id}` }]
      }
    ])
  )
  const time = new Date(args.timestamp)
  await utimes(file, time, time)
}

describe('scanAiVaultSessions — CodeBuddy scope discovery', () => {
  it('lists an older in-scope CodeBuddy session the recency cap would drop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codebuddy-scope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const workspace = '/home/ada/orca/workspaces/orca/feature'

    await writeCodeBuddySession({
      sessionsDir: roots.codebuddyProjectsDir,
      cwd: `${workspace}/packages/app`,
      id: 'old-in-scope',
      timestamp: '2026-05-01T10:00:00.000Z'
    })
    // Newer, out of scope, and a sibling whose encoding shares the workspace prefix.
    await writeCodeBuddySession({
      sessionsDir: roots.codebuddyProjectsDir,
      cwd: '/home/ada/other',
      id: 'recent-elsewhere',
      timestamp: '2026-06-01T10:00:00.000Z'
    })
    await writeCodeBuddySession({
      sessionsDir: roots.codebuddyProjectsDir,
      cwd: `${workspace}-sibling`,
      id: 'sibling',
      timestamp: '2026-04-01T10:00:00.000Z'
    })

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'linux',
      limit: 1,
      scopePaths: [workspace]
    })
    const ids = result.sessions.map((session) => session.sessionId)

    expect(ids).toContain('old-in-scope')
    expect(ids).toContain('recent-elsewhere')
    expect(ids).not.toContain('sibling')
    expect(result.sessions.find((session) => session.sessionId === 'old-in-scope')?.agent).toBe(
      'codebuddy'
    )
  })

  it('finds an older session when another cwd shares its encoded bucket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codebuddy-collision-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    for (const [cwd, id, timestamp] of [
      ['/home/ada/repo/app', 'in-scope', '2026-04-01T10:00:00.000Z'],
      ['/home/ada/repo-app', 'collision', '2026-05-01T10:00:00.000Z'],
      ['/home/ada/elsewhere', 'recent', '2026-06-01T10:00:00.000Z']
    ]) {
      await writeCodeBuddySession({ sessionsDir: roots.codebuddyProjectsDir, cwd, id, timestamp })
    }
    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'linux',
      limit: 1,
      scopePaths: ['/home/ada/repo/app']
    })
    expect(result.sessions.map((session) => session.sessionId)).toContain('in-scope')
    expect(result.sessions.map((session) => session.sessionId)).not.toContain('collision')
  })

  it('adds nothing when no scope is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codebuddy-noscope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeCodeBuddySession({
      sessionsDir: roots.codebuddyProjectsDir,
      cwd: '/home/ada/old',
      id: 'old',
      timestamp: '2026-05-01T10:00:00.000Z'
    })
    await writeCodeBuddySession({
      sessionsDir: roots.codebuddyProjectsDir,
      cwd: '/home/ada/new',
      id: 'new',
      timestamp: '2026-06-01T10:00:00.000Z'
    })

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux', limit: 1 })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['new'])
  })
})
