import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { writeOpenCodeSqliteDatabase } from './scanners/opencode/sqlite/session-scanner-opencode-sqlite-fixture'
import type { AiVaultScanOptions } from './session-scanner-types'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'

// Worker bundles are absent in tests; read OpenCode's database in-process instead.
vi.mock(
  './scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async (importOriginal) => {
    const list = await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const parse = await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite')
    return {
      ...(await importOriginal<object>()),
      listOpenCodeSqliteSessionsViaWorker: list.listOpenCodeSqliteSessions,
      parseOpenCodeSqliteSessionViaWorker: parse.parseOpenCodeSqliteSession
    }
  }
)

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Isolate Claude fixtures from every other source root.
function scopedScanOptions(claudeProjectsDir: string, extra: Partial<AiVaultScanOptions>) {
  return {
    claudeProjectsDir,
    codexSessionsDir: '/nonexistent/codex',
    geminiSessionsDir: '/nonexistent/gemini',
    antigravityBrainDir: '/nonexistent/antigravity',
    copilotSessionsDir: '/nonexistent/copilot',
    cursorProjectsDir: '/nonexistent/cursor',
    opencodeStorageDir: '/nonexistent/opencode',
    opencodeDbPaths: [],
    grokSessionsDir: '/nonexistent/grok',
    devinTranscriptsDir: '/nonexistent/devin',
    hermesSessionsDir: '/nonexistent/hermes',
    rovoSessionsDir: '/nonexistent/rovo',
    openclawStateDir: '/nonexistent/openclaw',
    openclawLegacyStateDir: '/nonexistent/openclaw-legacy',
    piSessionsDir: '/nonexistent/pi',
    droidSessionsDir: '/nonexistent/droid',
    droidProjectsDir: '/nonexistent/droid-projects',
    kimiSessionsDir: '/nonexistent/kimi',
    ...extra
  } satisfies AiVaultScanOptions
}

async function writeClaudeSession(args: {
  claudeRoot: string
  dirName: string
  sessionId: string
  cwd: string
  iso: string
  leadingCwdlessLine?: boolean
}): Promise<void> {
  const dir = join(args.claudeRoot, args.dirName)
  await mkdir(dir, { recursive: true })
  const records: unknown[] = []
  if (args.leadingCwdlessLine) {
    records.push({ type: 'last-prompt', sessionId: args.sessionId })
  }
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

describe('scanAiVaultSessions scope inclusion', () => {
  it('surfaces in-scope sessions older than the global recency cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
    tempRoots.push(root)
    const claudeRoot = join(root, 'claude-projects')

    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'old-in-scope',
      cwd: '/repo/app',
      iso: '2026-01-01T00:00:00.000Z',
      leadingCwdlessLine: true
    })
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app-packages-ui',
      sessionId: 'old-in-scope-subdir',
      cwd: '/repo/app/packages/ui',
      iso: '2026-01-02T00:00:00.000Z'
    })
    for (let index = 0; index < 4; index++) {
      await writeClaudeSession({
        claudeRoot,
        dirName: `-other-${index}`,
        sessionId: `recent-${index}`,
        cwd: `/other/${index}`,
        iso: `2026-06-2${index}T00:00:00.000Z`
      })
    }

    const withoutScope = await scanAiVaultSessions(scopedScanOptions(claudeRoot, { limit: 2 }))
    const withScope = await scanAiVaultSessions(
      scopedScanOptions(claudeRoot, { limit: 2, scopePaths: ['/repo/app'] })
    )

    const ids = (result: { sessions: { sessionId: string }[] }) =>
      result.sessions.map((session) => session.sessionId)

    expect(ids(withoutScope)).not.toContain('old-in-scope')
    expect(ids(withoutScope)).not.toContain('old-in-scope-subdir')
    expect(ids(withScope)).toContain('old-in-scope')
    expect(ids(withScope)).toContain('old-in-scope-subdir')
  })

  it('answers a scope-only scan from in-scope sessions alone, recent ones included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const claudeRoot = roots.claudeProjectsDir
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'recent-in-scope',
      cwd: '/repo/app',
      iso: '2026-06-25T00:00:00.000Z'
    })
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'old-in-scope',
      cwd: '/repo/app',
      iso: '2026-01-01T00:00:00.000Z'
    })
    await writeClaudeSession({
      claudeRoot,
      dirName: '-other',
      sessionId: 'recent-elsewhere',
      cwd: '/other',
      iso: '2026-06-24T00:00:00.000Z'
    })
    for (const [id, cwd] of [
      ['019f0000-1111-7222-8333-000000000001', '/repo/app'],
      ['019f0000-1111-7222-8333-000000000002', '/other']
    ]) {
      await writeJsonlFile(
        join(roots.codexSessionsDir, '2026', '06', '25', `rollout-${id}.jsonl`),
        [
          { timestamp: '2026-06-25T01:00:00.000Z', type: 'session_meta', payload: { id, cwd } },
          {
            timestamp: '2026-06-25T01:00:05.000Z',
            type: 'event_msg',
            payload: { type: 'user_message', message: `work in ${cwd}` }
          }
        ]
      )
    }
    const opencodeDb = join(root, 'opencode', 'opencode.db')
    writeOpenCodeSqliteDatabase(
      opencodeDb,
      [
        ['ses_in_scope', '/repo/app'],
        ['ses_elsewhere', '/other']
      ].map(([id, directory]) => ({
        id,
        directory,
        turns: [{ role: 'user' as const, parts: [`work in ${directory}`] }]
      }))
    )
    const options = {
      ...roots,
      opencodeDbPaths: [opencodeDb],
      limit: 10,
      scopePaths: ['/repo/app']
    }
    const ids = (result: { sessions: { sessionId: string }[] }) =>
      result.sessions.map((session) => session.sessionId).sort()

    const controller = new AbortController()
    const stopTracking = trackAiVaultScanProgress(controller.signal, () => {})
    const scopeOnly = await scanAiVaultSessions({
      ...options,
      scopeOnly: true,
      signal: controller.signal
    })
    const claudeFiles = aiVaultScanWork(controller.signal)?.agents.find(
      (agent) => agent.agent === 'claude'
    )?.files
    stopTracking()
    const widened = await scanAiVaultSessions(options)

    expect(ids(scopeOnly)).toEqual([
      '019f0000-1111-7222-8333-000000000001',
      'old-in-scope',
      'recent-in-scope',
      'ses_in_scope'
    ])
    // The scanned-files count still reports the in-scope Claude transcripts it read.
    expect(claudeFiles).toBe(2)
    // All keeps sending scopePaths without scopeOnly and still gets the newest sessions everywhere.
    expect(ids(widened)).toEqual([
      '019f0000-1111-7222-8333-000000000001',
      '019f0000-1111-7222-8333-000000000002',
      'old-in-scope',
      'recent-elsewhere',
      'recent-in-scope',
      'ses_elsewhere',
      'ses_in_scope'
    ])
  })

  it('finds scope-only Claude buckets for a root, another-case Windows path, hashed and full-length long paths and either WSL share', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeClaudeSession({
      claudeRoot: roots.claudeProjectsDir,
      dirName: '-repo-app',
      sessionId: 'posix-session',
      cwd: '/repo/app',
      iso: '2026-06-25T00:00:00.000Z'
    })
    await writeClaudeSession({
      claudeRoot: roots.claudeProjectsDir,
      dirName: 'C--Users-Ada-repo',
      sessionId: 'win-session',
      cwd: 'C:\\Users\\Ada\\repo',
      iso: '2026-06-25T00:00:00.000Z'
    })
    await writeClaudeSession({
      claudeRoot: roots.claudeProjectsDir,
      dirName: '--wsl--Ubuntu-home-ada-repo',
      sessionId: 'wsl-session',
      cwd: '\\\\wsl$\\Ubuntu\\home\\ada\\repo',
      iso: '2026-06-25T00:00:00.000Z'
    })
    const longPath = `/repo/${'nested-folder/'.repeat(16)}app`
    await writeClaudeSession({
      claudeRoot: roots.claudeProjectsDir,
      dirName: `${longPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-1a2b3c`,
      sessionId: 'long-session',
      cwd: longPath,
      iso: '2026-06-25T00:00:00.000Z'
    })
    // Older Claude Code kept the full encoded name for paths under the filesystem's name limit.
    await writeClaudeSession({
      claudeRoot: roots.claudeProjectsDir,
      dirName: longPath.replace(/[^a-zA-Z0-9]/g, '-'),
      sessionId: 'legacy-long-session',
      cwd: longPath,
      iso: '2026-06-25T00:00:00.000Z'
    })
    const scan = (scopePaths: string[]) =>
      scanAiVaultSessions({ ...roots, limit: 5, scopePaths, scopeOnly: true }).then((result) =>
        result.sessions.map((session) => session.sessionId)
      )

    expect(await scan(['/'])).toContain('posix-session')
    expect(await scan(['c:\\users\\ada\\repo'])).toEqual(['win-session'])
    expect((await scan([longPath])).sort()).toEqual(['legacy-long-session', 'long-session'])
    expect(await scan(['\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'])).toEqual(['wsl-session'])
  })

  it('does not duplicate sessions already in the capped result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
    tempRoots.push(root)
    const claudeRoot = join(root, 'claude-projects')

    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'recent-in-scope',
      cwd: '/repo/app',
      iso: '2026-06-24T00:00:00.000Z'
    })

    const result = await scanAiVaultSessions(
      scopedScanOptions(claudeRoot, { limit: 50, scopePaths: ['/repo/app'] })
    )

    const matches = result.sessions.filter((session) => session.sessionId === 'recent-in-scope')
    expect(matches).toHaveLength(1)
  })

  it('does not assign a native transcript to a WSL distro from cwd alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
    tempRoots.push(root)
    const claudeRoot = join(root, 'claude-projects')

    await writeClaudeSession({
      claudeRoot,
      dirName: '-home-ada-repo',
      sessionId: 'old-wsl-in-scope',
      cwd: '/home/ada/repo',
      iso: '2026-01-01T00:00:00.000Z'
    })
    for (let index = 0; index < 4; index++) {
      await writeClaudeSession({
        claudeRoot,
        dirName: `-other-wsl-${index}`,
        sessionId: `recent-wsl-${index}`,
        cwd: `/other/wsl/${index}`,
        iso: `2026-06-2${index}T00:00:00.000Z`
      })
    }

    const result = await scanAiVaultSessions(
      scopedScanOptions(claudeRoot, {
        limit: 2,
        scopePaths: ['\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo']
      })
    )

    expect(result.sessions.map((session) => session.sessionId)).not.toContain('old-wsl-in-scope')
  })
})
