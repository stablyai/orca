import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { filterAiVaultSessions } from '../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { scanAiVaultSessions } from '../../session-scanner'
import { antigravityChatBrainDir } from '../../../antigravity/antigravity-chat-home'
import { isAntigravityReferenceSession } from '../../../../shared/antigravity-session-origin'
import {
  isolatedScanRoots,
  writeAntigravityHistory,
  writeAntigravityTranscript
} from '../../session-scanner-test-fixtures'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Antigravity AI Vault discovery', () => {
  it("lists Orca's managed chat sessions in their workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-antigravity-chat-'))
    tempRoots.push(root)
    const stateDirectory = join(root, 'user-data')
    const acpHome = join(stateDirectory, 'antigravity-chat', 'antigravity-acp')
    const sessionId = '2b7e1f0c-5d3a-4c8e-9f21-6a4b8c0d1e2f'
    const workspace = join(root, 'repo')
    await writeAntigravityTranscript(join(acpHome, 'brain'), sessionId, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-04T10:00:00.000Z',
        content: '<USER_REQUEST>ORCA_38100_REPRO</USER_REQUEST>'
      },
      {
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-04T10:00:05.000Z',
        content: 'done'
      }
    ])
    // Shape the 1.4.1 server writes: indented JSON, merged with later keys.
    await mkdir(join(acpHome, 'conversations'), { recursive: true })
    await writeFile(
      join(acpHome, 'conversations', `${sessionId}.meta`),
      JSON.stringify({ cwd: workspace, mode_id: 'default' }, null, 2)
    )

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      antigravityChatBrainDir: antigravityChatBrainDir(stateDirectory),
      includeAntigravityIdeSessions: true,
      platform: 'darwin'
    })

    const sessions = filterAiVaultSessions(result.sessions, {
      query: '',
      agents: AI_VAULT_AGENTS,
      scope: 'workspace',
      sort: 'updated',
      activeWorktreePaths: [workspace],
      hideEmptySessions: true
    })
    expect(sessions.map((session) => [session.sessionId, session.cwd])).toEqual([
      [sessionId, workspace]
    ])
    // agy cannot open the server's conversations, so only the owning chat may reopen it natively.
    expect(isAntigravityReferenceSession(sessions[0]!)).toBe(true)
    expect(
      isAntigravityReferenceSession({
        ...sessions[0]!,
        structuredSession: { sessionId: 'chat', workspaceId: 'wt' }
      })
    ).toBe(false)
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
    // Leave the transcript unchanged to exercise history enrichment on a cached parse.
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
