import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { filterAiVaultSessions } from '../../shared/ai-vault-session-filters'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'
import {
  isolatedScanRoots,
  writeAntigravityHistory,
  writeAntigravityTranscript
} from './session-scanner-test-fixtures'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Antigravity AI Vault discovery', () => {
  it('discovers canonical transcripts from WSL homes without indexing sibling artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-wsl-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const wslHome = join(root, 'wsl-home')
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const transcriptPath = await writeAntigravityTranscript(
      join(wslHome, '.gemini', 'antigravity-cli', 'brain'),
      sessionId,
      [
        {
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-07-15T11:39:10Z',
          content: '<USER_REQUEST>Index the WSL conversation</USER_REQUEST>'
        }
      ]
    )
    await writeFile(join(dirname(transcriptPath), 'transcript_full.jsonl'), 'duplicate')
    await writeAntigravityHistory(join(wslHome, '.gemini', 'antigravity-cli', 'brain'), [
      {
        display: 'Index the WSL conversation',
        timestamp: Date.parse('2026-07-15T11:39:10.100Z') / 1000,
        workspace: '/home/ada/project'
      }
    ])

    const result = await scanAiVaultSessions({
      ...roots,
      wslHomeDirs: [wslHome],
      platform: 'linux'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'antigravity',
      sessionId,
      title: 'Index the WSL conversation',
      cwd: '/home/ada/project',
      resumeCommand: `agy --conversation '${sessionId}'`,
      filePath: transcriptPath
    })
  })

  it('uses a unique history match in the default workspace view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-workspace-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    const workspace = join(root, 'active-workspace')
    await writeAntigravityTranscript(roots.antigravityBrainDir, sessionId, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-07-15T11:39:10.000Z',
        content: '<USER_REQUEST>ORCA_8742_REPRO</USER_REQUEST>'
      }
    ])

    const beforeHistory = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(beforeHistory.sessions[0]?.cwd).toBeNull()

    await writeAntigravityHistory(roots.antigravityBrainDir, [
      {
        display: 'ORCA_8742_REPRO',
        timestamp: Date.parse('2026-07-15T11:39:10.100Z'),
        workspace
      }
    ])
    // The transcript is unchanged, so this also covers history refresh after a
    // cached incremental parse has already been stored.
    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions[0]?.cwd).toBe(workspace)
    expect(
      filterAiVaultSessions(result.sessions, {
        query: '',
        agents: AI_VAULT_AGENTS,
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: [workspace],
        hideEmptySessions: true
      }).map((session) => session.sessionId)
    ).toEqual([sessionId])
  })

  it('keeps workspace unknown when matching history rows are ambiguous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-ambiguous-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
    await writeAntigravityTranscript(roots.antigravityBrainDir, sessionId, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-07-15T11:39:10.000Z',
        content: '<USER_REQUEST>Repeated prompt</USER_REQUEST>'
      }
    ])
    await writeAntigravityHistory(roots.antigravityBrainDir, [
      {
        display: 'Repeated prompt',
        timestamp: Date.parse('2026-07-15T11:39:09.900Z'),
        workspace: '/repo/one'
      },
      {
        display: 'Repeated prompt',
        timestamp: Date.parse('2026-07-15T11:39:10.100Z'),
        workspace: '/repo/two'
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })

    expect(result.sessions[0]?.cwd).toBeNull()
  })

  it('does not join workspace from a colliding truncated prompt title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-long-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc'
    const commonPrefix = 'shared worker preamble '.repeat(7)
    await writeAntigravityTranscript(roots.antigravityBrainDir, sessionId, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-07-15T11:39:10.000Z',
        content: `<USER_REQUEST>${commonPrefix}workspace A</USER_REQUEST>`
      }
    ])
    await writeAntigravityHistory(roots.antigravityBrainDir, [
      {
        display: `${commonPrefix}workspace B`,
        timestamp: Date.parse('2026-07-15T11:39:10.100Z'),
        workspace: '/repo/wrong'
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })

    expect(result.sessions[0]?.title).toHaveLength(96)
    expect(result.sessions[0]?.title).toMatch(/\.\.\.$/)
    expect(result.sessions[0]?.cwd).toBeNull()
  })
})
