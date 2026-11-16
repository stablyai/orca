import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'

const scanAiVaultSessions = vi.hoisted(() => vi.fn())
vi.mock('../session-scanner', () => ({ scanAiVaultSessions }))
const deleteWorkspaceHistorySqliteSessions = vi.hoisted(() => vi.fn())
vi.mock('./workspace-history-sqlite-delete', () => ({ deleteWorkspaceHistorySqliteSessions }))

const { runWorkspaceHistory } = await import('./workspace-history-run')

const OLD = new Date('2026-11-01T00:00:00.000Z')
const RECENT = new Date('2026-11-12T00:00:00.000Z')
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-history-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function codexSession(filePath: string, cwd: string, modifiedAt: string): AiVaultSession {
  return {
    id: filePath,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: filePath,
    title: '',
    cwd,
    branch: null,
    model: null,
    filePath,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

function writeRollout(sessionsDir: string, name: string): string {
  const dir = join(sessionsDir, '2026', '11', '01')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '{"type":"session_meta"}\n')
  utimesSync(path, OLD, OLD)
  return path
}

describe('runWorkspaceHistory', () => {
  it('deletes every Codex link and archive twin, keeping nested survivors and recent sessions', async () => {
    const systemSessions = join(root, 'codex', 'sessions')
    const accountSessions = join(root, 'account', 'home', 'sessions')
    const removed = join(root, 'workspaces', 'repo', 'gone')
    const owned = writeRollout(systemSessions, 'rollout-a.jsonl')
    writeFileSync(`${owned}.zst`, 'archived')
    utimesSync(`${owned}.zst`, OLD, OLD)
    const accountLink = writeRollout(accountSessions, 'rollout-a.jsonl')
    rmSync(accountLink)
    linkSync(owned, accountLink)
    const nested = writeRollout(systemSessions, 'rollout-b.jsonl')
    const recent = writeRollout(systemSessions, 'rollout-c.jsonl')
    utimesSync(recent, RECENT, RECENT)
    scanAiVaultSessions.mockResolvedValue({
      sessions: [
        codexSession(owned, join(removed, 'src'), '2026-11-01T00:00:00.000Z'),
        codexSession(nested, join(removed, 'nested', 'pkg'), '2026-11-01T00:00:00.000Z'),
        codexSession(recent, removed, '2026-11-15T00:00:00.000Z')
      ],
      issues: [],
      scannedAt: '2026-11-15'
    })

    const result = await runWorkspaceHistory(
      {
        mode: 'delete',
        ownership: {
          scope: { kind: 'removed', paths: [removed] },
          keepPaths: [join(removed, 'nested')]
        },
        inUseSince: Date.parse('2026-11-10T00:00:00.000Z'),
        options: {
          codexSessionsDir: systemSessions,
          additionalCodexSessionsDirs: [accountSessions]
        }
      },
      new AbortController().signal
    )

    expect(result).toMatchObject({ matched: 2, inUse: 1, deleted: 1, failed: 0 })
    expect(existsSync(owned)).toBe(false)
    expect(existsSync(`${owned}.zst`)).toBe(false)
    expect(existsSync(accountLink)).toBe(false)
    expect(existsSync(nested)).toBe(true)
    expect(existsSync(recent)).toBe(true)
  })

  it('keeps sessions under a workspace root that is missing, as on an unmounted volume', async () => {
    const sessions = join(root, 'codex', 'sessions')
    const rollout = writeRollout(sessions, 'rollout-a.jsonl')
    const unmountedRoot = join(root, 'Volumes', 'External', 'workspaces')
    scanAiVaultSessions.mockResolvedValue({
      sessions: [
        codexSession(rollout, join(unmountedRoot, 'repo', 'ws'), '2026-11-01T00:00:00.000Z')
      ],
      issues: [],
      scannedAt: '2026-11-15'
    })

    const result = await runWorkspaceHistory(
      {
        mode: 'delete',
        ownership: {
          scope: {
            kind: 'already-deleted',
            layouts: [{ path: unmountedRoot, nestWorkspaces: true }]
          },
          keepPaths: []
        },
        inUseSince: Date.parse('2026-11-10T00:00:00.000Z'),
        options: { codexSessionsDir: sessions }
      },
      new AbortController().signal
    )

    expect(result).toMatchObject({ total: 1, matched: 0, deleted: 0 })
    expect(existsSync(rollout)).toBe(true)
  })

  it('deletes an OpenCode session whose path already names its database row', async () => {
    const dbPath = join(root, 'opencode', 'opencode.db')
    const workspace = join(root, 'workspaces', 'gone')
    deleteWorkspaceHistorySqliteSessions.mockResolvedValue({ deleted: ['ses_1'], busy: [] })
    scanAiVaultSessions.mockResolvedValue({
      sessions: [
        {
          ...codexSession(`${dbPath}#ses_1`, workspace, '2026-11-01T00:00:00.000Z'),
          agent: 'opencode',
          sessionId: 'ses_1'
        }
      ],
      issues: [],
      scannedAt: '2026-11-15'
    })

    const result = await runWorkspaceHistory(
      {
        mode: 'delete',
        ownership: { scope: { kind: 'removed', paths: [workspace] }, keepPaths: [] },
        inUseSince: Date.parse('2026-11-10T00:00:00.000Z'),
        options: {}
      },
      new AbortController().signal
    )

    expect(deleteWorkspaceHistorySqliteSessions).toHaveBeenCalledWith(
      dbPath,
      ['ses_1'],
      Date.parse('2026-11-10T00:00:00.000Z'),
      expect.anything()
    )
    expect(result).toMatchObject({ deleted: 1, failed: 0 })
  })
})
