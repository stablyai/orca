import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import type { AiVaultScanOptions } from './session-scanner-types'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function scopedScanOptions(claudeProjectsDir: string, extra: Partial<AiVaultScanOptions>) {
  return {
    ...isolatedScanRoots(claudeProjectsDir),
    claudeProjectsDir,
    ...extra
  } satisfies AiVaultScanOptions
}

// Recent out-of-scope sessions fill the recency pass, so the old session can only come from the scope pass.
async function writeOldClaudeSessionBehindRecentOnes(
  claudeRoot: string,
  old: { dirName: string; cwd: string }
): Promise<void> {
  await writeClaudeSession({
    claudeRoot,
    ...old,
    sessionId: 'old-in-scope',
    iso: '2026-01-01T00:00:00.000Z'
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
}

const LONG_PATH = `/repo/${'nested-folder/'.repeat(16)}app`

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

  it.each([
    { layout: 'a drive root', scopePath: 'C:\\', dirName: 'C--repo', cwd: 'C:\\repo' },
    {
      layout: 'a Windows path in another case',
      scopePath: 'c:\\users\\ada\\repo',
      dirName: 'C--Users-Ada-repo',
      cwd: 'C:\\Users\\Ada\\repo'
    },
    {
      layout: 'the other WSL share spelling',
      scopePath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo',
      dirName: '--wsl--Ubuntu-home-ada-repo',
      cwd: '\\\\wsl$\\Ubuntu\\home\\ada\\repo'
    },
    {
      // Claude Code names a bucket over 200 characters `<first 200>-<hash>`.
      layout: 'a long path',
      scopePath: LONG_PATH,
      dirName: `${LONG_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-1a2b3c`,
      cwd: LONG_PATH
    }
  ])('finds older in-scope Claude sessions for $layout', async ({ scopePath, dirName, cwd }) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
    tempRoots.push(root)
    const claudeRoot = join(root, 'claude-projects')
    await writeOldClaudeSessionBehindRecentOnes(claudeRoot, { dirName, cwd })

    const result = await scanAiVaultSessions(
      scopedScanOptions(claudeRoot, { limit: 2, scopePaths: [scopePath] })
    )

    expect(result.sessions.map((session) => session.sessionId)).toContain('old-in-scope')
  })

  // chmod cannot lock out root, and Windows ignores the mode bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable in-scope folder instead of listing it as empty',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-'))
      tempRoots.push(root)
      const claudeRoot = join(root, 'claude-projects')
      await writeOldClaudeSessionBehindRecentOnes(claudeRoot, {
        dirName: '-repo-app',
        cwd: '/repo/app'
      })
      const bucket = join(claudeRoot, '-repo-app')
      await chmod(bucket, 0o000)
      try {
        const result = await scanAiVaultSessions(
          scopedScanOptions(claudeRoot, { limit: 2, scopePaths: ['/repo/app'] })
        )

        expect(result.issues.map((issue) => issue.path)).toContain(bucket)
      } finally {
        await chmod(bucket, 0o755)
      }
    }
  )
})
