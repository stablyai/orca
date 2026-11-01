import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseCopilotSessionFile } from './session-scanner-copilot-parser'

const DATETIME = '<current_datetime>2026-10-19T18:40:06.682-03:00</current_datetime>'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function startRecord(context?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'session.start',
    data: { sessionId: 'copilot-session', startTime: '2026-10-19T21:40:00.000Z', context },
    timestamp: '2026-10-19T21:40:00.000Z'
  }
}

function trustRecord(folder: string): Record<string, unknown> {
  return {
    type: 'session.info',
    data: {
      infoType: 'folder_trust',
      message: `Folder ${folder} has been added to trusted folders.`
    },
    timestamp: '2026-10-19T21:40:01.000Z'
  }
}

function userRecord(data: Record<string, unknown>): Record<string, unknown> {
  return { type: 'user.message', data, timestamp: '2026-10-19T21:40:06.000Z' }
}

async function parse(
  records: Record<string, unknown>[],
  platform: NodeJS.Platform = 'linux'
): Promise<AiVaultSession> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-copilot-parser-'))
  tempDirs.push(dir)
  const path = join(dir, 'events.jsonl')
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'))
  const session = await parseCopilotSessionFile(
    { path, mtimeMs: Date.now(), modifiedAt: new Date().toISOString() },
    platform
  )
  if (!session) {
    throw new Error('Missing Copilot fixture session')
  }
  return session
}

describe('parseCopilotSessionFile location', () => {
  it('takes the workspace and branch from the session start context', async () => {
    const session = await parse([
      startRecord({ cwd: '/repo/worktree', gitRoot: '/repo', branch: 'feature/x' }),
      userRecord({ content: 'fix the bug' })
    ])

    expect(session.cwd).toBe('/repo/worktree')
    expect(session.branch).toBe('feature/x')
    expect(session.resumeCommand).toContain("cd '/repo/worktree'")
  })

  it('falls back to the git root when the start context has no cwd', async () => {
    const session = await parse([startRecord({ gitRoot: '/repo' }), userRecord({ content: 'hi' })])

    expect(session.cwd).toBe('/repo')
  })

  it('keeps the start directory when a folder-trust notice names another folder', async () => {
    const session = await parse([
      startRecord({ cwd: '/repo/worktree' }),
      trustRecord('/repo'),
      userRecord({ content: 'hi' })
    ])

    expect(session.cwd).toBe('/repo/worktree')
  })

  it('still uses the folder-trust notice when the start has no context', async () => {
    const session = await parse([
      startRecord(),
      trustRecord('/tmp/copilot'),
      userRecord({ content: 'hi' })
    ])

    expect(session.cwd).toBe('/tmp/copilot')
  })

  it('resumes a Windows session in its start directory', async () => {
    const cwd = 'C:\\Users\\me\\my repo'
    const session = await parse(
      [startRecord({ cwd, gitRoot: cwd, branch: 'main' }), userRecord({ content: 'hi' })],
      'win32'
    )

    expect(session.cwd).toBe(cwd)
    expect(session.resumeCommand).toMatch(/^cmd \/d \/s \/c /)
    expect(session.resumeCommand).toContain(`cd /d ""${cwd}"" && copilot --resume=`)
  })
})

describe('parseCopilotSessionFile titles', () => {
  it('titles the session with the original prompt, not the transformed one', async () => {
    const session = await parse([
      startRecord({ cwd: '/repo' }),
      userRecord({
        content: 'fix the login bug',
        transformedContent: `${DATETIME}\nmodel-only context\nfix the login bug`
      })
    ])

    expect(session.title).toBe('fix the login bug')
    expect(session.previewMessages[0]?.text).toBe('fix the login bug')
  })

  it('strips the injected datetime when only transformed content exists', async () => {
    const session = await parse([
      startRecord({ cwd: '/repo' }),
      userRecord({ transformedContent: `${DATETIME}\nrefactor the parser` })
    ])

    expect(session.title).toBe('refactor the parser')
    expect(session.previewMessages[0]?.text).toBe('refactor the parser')
    expect(session.title).not.toContain('current_datetime')
  })
})
