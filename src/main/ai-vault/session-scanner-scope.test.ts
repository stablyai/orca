import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import type { AiVaultScanOptions } from './session-scanner-types'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Point every non-Claude source at a nonexistent dir so the scan only sees the
// Claude fixtures created per test.
function scopedScanOptions(claudeProjectsDir: string, extra: Partial<AiVaultScanOptions>) {
  return {
    claudeProjectsDir,
    codexSessionsDir: '/nonexistent/codex',
    geminiSessionsDir: '/nonexistent/gemini',
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

    // One old in-scope session that the recency cap would otherwise drop.
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app',
      sessionId: 'old-in-scope',
      cwd: '/repo/app',
      iso: '2026-01-01T00:00:00.000Z',
      leadingCwdlessLine: true
    })
    // A session in a sub-cwd directory of the same workspace path.
    await writeClaudeSession({
      claudeRoot,
      dirName: '-repo-app-packages-ui',
      sessionId: 'old-in-scope-subdir',
      cwd: '/repo/app/packages/ui',
      iso: '2026-01-02T00:00:00.000Z'
    })
    // Recent out-of-scope sessions that fill the cap.
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

    // The cap hides the old in-scope sessions when no scope is provided.
    expect(ids(withoutScope)).not.toContain('old-in-scope')
    expect(ids(withoutScope)).not.toContain('old-in-scope-subdir')
    // Scope paths force them back in, including the sub-cwd directory.
    expect(ids(withScope)).toContain('old-in-scope')
    expect(ids(withScope)).toContain('old-in-scope-subdir')
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

  it('matches WSL UNC scope paths against Linux Claude cwd values', async () => {
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

    expect(result.sessions.map((session) => session.sessionId)).toContain('old-wsl-in-scope')
  })
})
