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

// Copied from Pi's getDefaultSessionDirPath (coding-agent session-manager.ts)
// rather than imported from the layout module, so the fixtures stay Pi-shaped.
function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

async function writePiSession(args: {
  sessionsDir: string
  cwd: string
  id: string
  timestamp: string
}): Promise<void> {
  const dir = join(args.sessionsDir, piSessionDirName(args.cwd))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${args.id}.jsonl`)
  await writeFile(
    file,
    jsonLines([
      { type: 'session', version: 3, id: args.id, timestamp: args.timestamp, cwd: args.cwd },
      {
        type: 'message',
        timestamp: args.timestamp,
        message: { role: 'user', content: [{ type: 'text', text: `prompt ${args.id}` }] }
      }
    ])
  )
  const time = new Date(args.timestamp)
  await utimes(file, time, time)
}

describe('scanAiVaultSessions — Pi scope discovery', () => {
  it('lists an older in-scope Pi session the recency cap would drop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-scope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const workspace = '/home/ada/orca/workspaces/orca/feature'

    await writePiSession({
      sessionsDir: roots.piSessionsDir,
      cwd: `${workspace}/packages/app`,
      id: 'old-in-scope',
      timestamp: '2026-05-01T10:00:00.000Z'
    })
    // Newer, out of scope, and a sibling whose encoding shares the workspace prefix.
    await writePiSession({
      sessionsDir: roots.piSessionsDir,
      cwd: '/home/ada/other',
      id: 'recent-elsewhere',
      timestamp: '2026-06-01T10:00:00.000Z'
    })
    await writePiSession({
      sessionsDir: roots.piSessionsDir,
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
      'pi'
    )
  })

  it('finds an older session when another cwd shares its encoded bucket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-pi-collision-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    for (const [cwd, id, timestamp] of [
      ['/home/ada/repo/app', 'in-scope', '2026-04-01T10:00:00.000Z'],
      ['/home/ada/repo-app', 'collision', '2026-05-01T10:00:00.000Z'],
      ['/home/ada/elsewhere', 'recent', '2026-06-01T10:00:00.000Z']
    ]) {
      await writePiSession({ sessionsDir: roots.piSessionsDir, cwd, id, timestamp })
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
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-noscope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writePiSession({
      sessionsDir: roots.piSessionsDir,
      cwd: '/home/ada/old',
      id: 'old',
      timestamp: '2026-05-01T10:00:00.000Z'
    })
    await writePiSession({
      sessionsDir: roots.piSessionsDir,
      cwd: '/home/ada/new',
      id: 'new',
      timestamp: '2026-06-01T10:00:00.000Z'
    })

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux', limit: 1 })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['new'])
  })
})
