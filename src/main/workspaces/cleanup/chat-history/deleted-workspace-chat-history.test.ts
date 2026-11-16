import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  sweepDeletedWorkspaceChatHistory,
  type ChatHistoryTarget
} from './deleted-workspace-chat-history'

const NOW = Date.parse('2026-11-16T12:00:00.000Z')
const DAY_AGO = '2026-11-15T12:00:00.000Z'
const TEN_MINUTES_AGO = '2026-11-16T11:50:00.000Z'

let root: string

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function session(
  filePath: string,
  cwd: string,
  overrides: Partial<AiVaultSession> = {}
): AiVaultSession {
  return {
    executionHostId: 'local',
    agent: 'claude',
    sessionId: filePath,
    cwd,
    filePath,
    modifiedAt: DAY_AGO,
    ...overrides
  } as AiVaultSession
}

describe('sweepDeletedWorkspaceChatHistory', () => {
  it('deletes only the history of Orca workspace folders that are gone from a mounted workspace directory', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
    const workspaces = join(root, 'workspaces')
    const appWorkspaces = join(workspaces, 'app')
    mkdirSync(join(appWorkspaces, 'live'), { recursive: true })
    mkdirSync(join(root, 'repos', 'app'), { recursive: true })
    const gone = join(appWorkspaces, 'gone')
    const store = {
      getSettings: () => ({
        workspaceDir: workspaces,
        nestWorkspaces: true,
        workspaceDirHistory: []
      }),
      getRepos: () => [
        {
          id: 'app',
          path: join(root, 'repos', 'app'),
          displayName: 'app',
          badgeColor: '',
          addedAt: 0
        },
        {
          id: 'other',
          path: join(root, 'repos', 'other'),
          displayName: 'other',
          badgeColor: '',
          addedAt: 0,
          worktreeBasePath: join(root, 'unmounted')
        }
      ],
      // Archived: the row stays while its folder is gone.
      getAllWorktreeMeta: () => ({ [`app::${join(appWorkspaces, 'archived')}`]: {} })
    } as unknown as RuntimeStore
    const deleted: ChatHistoryTarget[] = []

    const result = await sweepDeletedWorkspaceChatHistory({
      store,
      now: NOW,
      listSessions: async () => [
        session('gone.jsonl', gone),
        session('gone-subfolder.jsonl', join(gone, 'packages', 'web')),
        session('live.jsonl', join(appWorkspaces, 'live')),
        session('archived.jsonl', join(appWorkspaces, 'archived')),
        session('recent.jsonl', gone, { modifiedAt: TEN_MINUTES_AGO }),
        session('outside.jsonl', join(root, 'elsewhere', 'gone')),
        session('codex.jsonl', gone, { agent: 'codex' }),
        session('server.jsonl', gone, { executionHostId: 'runtime:env-1' }),
        session('unmounted.jsonl', join(root, 'unmounted', 'feature'))
      ],
      deleteSessions: async (targets) => {
        deleted.push(...targets)
        return { deleted: targets.length, failed: 0, freedBytes: 42 }
      }
    })

    expect(deleted).toEqual([
      { agent: 'claude', filePath: 'gone.jsonl' },
      { agent: 'claude', filePath: 'gone-subfolder.jsonl' }
    ])
    expect(result).toEqual({ deleted: 2, failed: 0, freedBytes: 42 })
  })
})
