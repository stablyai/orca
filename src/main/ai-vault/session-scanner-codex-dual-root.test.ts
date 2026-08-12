import { copyFile, link, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

// Scan-level coverage for the canonical-root rule when one physical Codex
// rollout is visible through both the real ~/.codex and the managed runtime
// home (the layout the session backfill and bridge produce via hardlinks).

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions codex dual-root dedup', () => {
  it('lists a backfilled both-roots session once, attributed to the real home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-dedup-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    // Sandbox "real ~/.codex" and Orca managed runtime home, hardlinked the
    // same way the session backfill links managed rollouts into the real home.
    const realHome = join(root, 'real-codex-home')
    const realSessionsDir = join(realHome, 'sessions')
    const managedHome = join(root, 'codex-runtime-home', 'home')
    const managedSessionsDir = join(managedHome, 'sessions')
    const rolloutName = 'rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
    await mkdir(join(managedSessionsDir, '2026', '07', '01'), { recursive: true })
    await mkdir(join(realSessionsDir, '2026', '07', '01'), { recursive: true })

    await writeFile(
      join(managedSessionsDir, '2026', '07', '01', rolloutName),
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: '019f0000-1111-7222-8333-444444444444', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Backfilled both-roots session' }]
          }
        }
      ])
    )
    await link(
      join(managedSessionsDir, '2026', '07', '01', rolloutName),
      join(realSessionsDir, '2026', '07', '01', rolloutName)
    )
    // A managed-only session (e.g. a backfill copy failure) must keep its
    // managed-home stamp so resume still targets the home that has it.
    await mkdir(join(managedSessionsDir, '2026', '07', '02'), { recursive: true })
    await writeFile(
      join(
        managedSessionsDir,
        '2026',
        '07',
        '02',
        'rollout-2026-07-02T09-00-00-029f0000-1111-7222-8333-555555555555.jsonl'
      ),
      jsonLines([
        {
          timestamp: '2026-07-02T09:00:00.000Z',
          type: 'session_meta',
          payload: { id: '029f0000-1111-7222-8333-555555555555', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-02T09:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Managed-only session' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      codexSessionsDir: realSessionsDir,
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [managedSessionsDir],
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    const codexSessions = result.sessions.filter((session) => session.agent === 'codex')
    expect(codexSessions).toHaveLength(2)

    const backfilled = codexSessions.find(
      (session) => session.sessionId === '019f0000-1111-7222-8333-444444444444'
    )
    expect(backfilled).toMatchObject({
      codexHome: null,
      filePath: join(realSessionsDir, '2026', '07', '01', rolloutName),
      resumeCommand: "cd '/repo/app' && codex resume '019f0000-1111-7222-8333-444444444444'"
    })
    expect(backfilled?.resumeCommand).not.toContain('CODEX_HOME')

    const managedOnly = codexSessions.find(
      (session) => session.sessionId === '029f0000-1111-7222-8333-555555555555'
    )
    expect(managedOnly).toMatchObject({
      codexHome: managedHome,
      resumeCommand: `cd '/repo/app' && CODEX_HOME='${managedHome}' codex resume '029f0000-1111-7222-8333-555555555555'`
    })
  })

  it('keeps different same-name rollouts from separate roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-collision-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const realHome = join(root, 'real-codex-home')
    const realSessionsDir = join(realHome, 'sessions')
    const managedHome = join(root, 'codex-runtime-home', 'home')
    const managedSessionsDir = join(managedHome, 'sessions')
    const rolloutName = 'rollout-2026-07-01T10-00-00-collision.jsonl'
    const realPath = join(realSessionsDir, rolloutName)
    const managedPath = join(managedSessionsDir, rolloutName)
    await mkdir(realSessionsDir, { recursive: true })
    await mkdir(managedSessionsDir, { recursive: true })
    await writeFile(
      realPath,
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'real-session', cwd: '/repo/real' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Real content' }]
          }
        }
      ])
    )
    await writeFile(
      managedPath,
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'managed-session', cwd: '/repo/managed' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Managed content' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      codexSessionsDir: realSessionsDir,
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [managedSessionsDir],
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'managed-session',
      'real-session'
    ])
  })

  it('fills the listing past cross-volume-style copy aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-copy-cap-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const realHome = join(root, 'real-codex-home')
    const realSessionsDir = join(realHome, 'sessions')
    const managedHome = join(root, 'codex-runtime-home', 'home')
    const managedSessionsDir = join(managedHome, 'sessions')
    const aliasName = 'rollout-2026-07-02T10-00-00-copy-alias.jsonl'
    const realAliasPath = join(realSessionsDir, aliasName)
    const managedAliasPath = join(managedSessionsDir, aliasName)
    const uniquePath = join(managedSessionsDir, 'rollout-2026-07-01T10-00-00-unique.jsonl')
    await mkdir(realSessionsDir, { recursive: true })
    await mkdir(managedSessionsDir, { recursive: true })
    await writeFile(
      realAliasPath,
      jsonLines([
        {
          timestamp: '2026-07-02T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'copied-session', cwd: '/repo/copied' }
        },
        {
          timestamp: '2026-07-02T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Copied content' }]
          }
        }
      ])
    )
    await copyFile(realAliasPath, managedAliasPath)
    await writeFile(
      uniquePath,
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'unique-session', cwd: '/repo/unique' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Unique content' }]
          }
        }
      ])
    )
    const newest = new Date('2026-07-02T10:00:00.000Z')
    const older = new Date('2026-07-01T10:00:00.000Z')
    await utimes(realAliasPath, newest, newest)
    await utimes(managedAliasPath, newest, newest)
    await utimes(uniquePath, older, older)

    const result = await scanAiVaultSessions({
      ...roots,
      codexSessionsDir: realSessionsDir,
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [managedSessionsDir],
      platform: 'darwin',
      limit: 2
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'copied-session',
      'unique-session'
    ])
    expect(result.sessions.find((session) => session.sessionId === 'copied-session')).toMatchObject(
      {
        codexHome: null,
        filePath: realAliasPath
      }
    )
  })
})
