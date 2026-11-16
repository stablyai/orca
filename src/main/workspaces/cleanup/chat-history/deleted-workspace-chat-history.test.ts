import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

let root = ''

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A day-old transcript on disk; `lastCwd` is where it was last resumed. */
function session(
  name: string,
  cwd: string,
  overrides: Partial<AiVaultSession> = {},
  lastCwd = cwd
): AiVaultSession {
  const filePath = join(root, 'transcripts', name)
  mkdirSync(join(root, 'transcripts'), { recursive: true })
  // A large final record with no cwd, as Claude's API blobs are, so the latest cwd sits far back.
  const blob = JSON.stringify({ type: 'api-request-blob', body: 'x'.repeat(300 * 1024) })
  writeFileSync(
    filePath,
    // The last record's tool call names the start folder too; only the record's own cwd counts.
    `${JSON.stringify({ cwd })}\n${JSON.stringify({ cwd: lastCwd, input: { cwd } })}\n${blob}\n`
  )
  utimesSync(filePath, new Date(DAY_AGO), new Date(DAY_AGO))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only the fields set here
  return {
    executionHostId: 'local',
    agent: 'claude',
    sessionId: name,
    cwd,
    filePath,
    modifiedAt: DAY_AGO,
    ...overrides
  } as AiVaultSession
}

describe('sweepDeletedWorkspaceChatHistory', () => {
  // Creating symlinks needs a privilege ordinary Windows CI lacks.
  it.skipIf(process.platform === 'win32')(
    'deletes only the history of Orca workspace folders that are gone from a mounted workspace directory',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
      const workspaces = join(root, 'workspaces')
      const appWorkspaces = join(workspaces, 'app')
      mkdirSync(join(appWorkspaces, 'live'), { recursive: true })
      mkdirSync(join(root, 'repos', 'app'), { recursive: true })
      mkdirSync(join(root, 'repos', 'sibling'), { recursive: true })
      // A flat workspace from before nesting, named like the `docs` repo.
      mkdirSync(join(workspaces, 'docs'), { recursive: true })
      // A clone Orca never made, where repo `api`'s nested workspaces would go.
      mkdirSync(join(workspaces, 'api', '.git'), { recursive: true })
      // A folder project reached through a symlink to repo `tools`' nested workspace folder.
      mkdirSync(join(workspaces, 'tools'), { recursive: true })
      mkdirSync(join(root, 'links'), { recursive: true })
      symlinkSync(join(workspaces, 'tools'), join(root, 'links', 'tools'))
      // A listed folder project under a link whose target workspace folder is gone.
      symlinkSync(join(appWorkspaces, 'linked-gone'), join(root, 'links', 'dangling'))
      symlinkSync(join(appWorkspaces, 'live'), join(root, 'links', 'moving'))
      // Transcript parsers trim the recorded cwd, so `spaced` must not read as gone.
      mkdirSync(join(appWorkspaces, 'spaced '), { recursive: true })
      // Agents record the physical cwd; the temp root can sit behind a symlink (macOS /var).
      const physical = (path: string): string => join(realpathSync(root), path.slice(root.length))
      const gone = join(appWorkspaces, 'gone')
      // Archived while the session scan runs: its row appears after the first read of the store.
      const archivedDuringScan: Record<string, object> = {}
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these store methods
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
          },
          {
            // Sibling worktrees: the base is the folder holding the user's other projects.
            id: 'sibling',
            path: join(root, 'repos', 'sibling'),
            displayName: 'sibling',
            badgeColor: '',
            addedAt: 0,
            worktreeBasePath: '..'
          },
          {
            id: 'docs',
            path: join(root, 'repos', 'docs'),
            displayName: 'docs',
            badgeColor: '',
            addedAt: 0
          },
          {
            id: 'api',
            path: join(root, 'repos', 'api'),
            displayName: 'api',
            badgeColor: '',
            addedAt: 0
          },
          {
            id: 'tools',
            path: join(root, 'repos', 'tools'),
            displayName: 'tools',
            badgeColor: '',
            addedAt: 0
          }
        ],
        // Archived: the row stays while its folder is gone, including one nested in a gone folder.
        getAllWorktreeMeta: () => ({
          ...archivedDuringScan,
          [`app::${join(appWorkspaces, 'archived')}`]: {},
          [`app::${join(appWorkspaces, 'team', 'feature')}`]: {},
          [`app::${join(workspaces, 'docs')}`]: {},
          // Renamed: chats recorded under the old folder still belong to it.
          [`app::${join(appWorkspaces, 'live')}`]: {
            priorWorktreeIds: [`app::${join(appWorkspaces, 'old-name')}`]
          }
        }),
        getFolderWorkspaces: () => [
          { folderPath: join(appWorkspaces, 'folder-workspace') },
          { folderPath: join(root, 'links', 'tools') },
          { folderPath: join(root, 'links', 'dangling', 'nested') },
          // Points at a live workspace until the sweep has started deleting `gone-seven`.
          { folderPath: join(root, 'links', 'moving') }
        ]
      } as unknown as RuntimeStore
      const deleted: ChatHistoryTarget[] = []

      // A subagent of this chat still writes from a live workspace; deleting the chat would take it too.
      const withLiveSubagent = session('live-subagent.jsonl', join(appWorkspaces, 'gone-five'))
      mkdirSync(join(root, 'transcripts', 'live-subagent', 'subagents'), { recursive: true })
      writeFileSync(
        join(root, 'transcripts', 'live-subagent', 'subagents', 'agent-1.jsonl'),
        `${JSON.stringify({ cwd: join(appWorkspaces, 'live') })}\n`
      )
      const sessionsToList = [
        withLiveSubagent,
        session('gone.jsonl', gone),
        session('gone-subfolder.jsonl', join(gone, 'packages', 'web')),
        session('live.jsonl', join(appWorkspaces, 'live')),
        session('archived.jsonl', join(appWorkspaces, 'archived')),
        session('recent.jsonl', gone, { modifiedAt: TEN_MINUTES_AGO }),
        session('outside.jsonl', join(root, 'elsewhere', 'gone')),
        session('codex.jsonl', gone, { agent: 'codex' }),
        session('server.jsonl', gone, { executionHostId: 'runtime:env-1' }),
        session('unmounted.jsonl', join(root, 'unmounted', 'other', 'feature')),
        session('renamed.jsonl', join(appWorkspaces, 'old-name')),
        session('folder-workspace.jsonl', join(appWorkspaces, 'folder-workspace')),
        session('nested-archived.jsonl', join(appWorkspaces, 'team', 'feature')),
        session('not-a-workspace.jsonl', join(root, 'repos', 'sibling', 'old-tool')),
        session('flat-workspace-subfolder.jsonl', join(workspaces, 'docs', 'packages', 'old')),
        session('gone-physical.jsonl', physical(join(appWorkspaces, 'gone-two'))),
        // Archived right after its first chat is removed: the second must still be kept.
        session('retargeted-1.jsonl', join(appWorkspaces, 'gone-seven')),
        session('retargeted-2.jsonl', join(appWorkspaces, 'gone-seven')),
        session('archived-between-1.jsonl', join(appWorkspaces, 'gone-six')),
        session('archived-between-2.jsonl', join(appWorkspaces, 'gone-six')),
        session('checkout-subfolder.jsonl', physical(join(root, 'repos', 'sibling', 'website'))),
        session('unrelated-clone.jsonl', join(workspaces, 'api', 'old-package')),
        session('symlinked-folder-project.jsonl', join(workspaces, 'tools', 'old')),
        session('trimmed-cwd.jsonl', join(appWorkspaces, 'spaced')),
        session('archived-mid-scan.jsonl', join(appWorkspaces, 'archived-mid-scan')),
        session('pi.jsonl', gone, { agent: 'pi' }),
        session('dangling-link-target.jsonl', join(appWorkspaces, 'linked-gone', 'nested')),
        session(
          'resumed-elsewhere.jsonl',
          join(appWorkspaces, 'gone-three'),
          {},
          join(appWorkspaces, 'live')
        )
      ]

      const result = await sweepDeletedWorkspaceChatHistory({
        store,
        now: NOW,
        listSessions: async () => {
          archivedDuringScan[`app::${join(appWorkspaces, 'archived-mid-scan')}`] = {}
          return sessionsToList
        },
        isEnabled: () => true,
        deleteSessions: async (targets, shouldDelete) => {
          const removed: ChatHistoryTarget[] = []
          for (const target of targets) {
            if (await shouldDelete(target)) {
              removed.push(target)
              if (basename(target.filePath) === 'retargeted-1.jsonl') {
                unlinkSync(join(root, 'links', 'moving'))
                symlinkSync(join(appWorkspaces, 'gone-seven'), join(root, 'links', 'moving'))
              }
              if (basename(target.filePath) === 'archived-between-1.jsonl') {
                archivedDuringScan[`app::${join(appWorkspaces, 'gone-six')}`] = {}
              }
            }
          }
          deleted.push(...removed)
          return { deleted: removed.length, failed: 0, freedBytes: 21 * removed.length }
        }
      })

      expect(deleted.map((target) => basename(target.filePath))).toEqual([
        'gone.jsonl',
        'gone-subfolder.jsonl',
        'gone-physical.jsonl',
        'retargeted-1.jsonl',
        'archived-between-1.jsonl'
      ])
      expect(result).toEqual({ deleted: 5, failed: 0, freedBytes: 105 })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'deletes nothing while a listed path has a symlink chain too long to follow',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
      const workspaces = join(root, 'workspaces')
      mkdirSync(join(workspaces, 'app'), { recursive: true })
      mkdirSync(join(root, 'repos', 'app'), { recursive: true })
      // Nine links in a row; the last points into the gone workspace.
      for (let hop = 0; hop < 9; hop += 1) {
        const target = hop === 8 ? join(workspaces, 'app', 'gone') : join(root, `link-${hop + 1}`)
        symlinkSync(target, join(root, `link-${hop}`))
      }
      const deleted: ChatHistoryTarget[] = []
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these store methods
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
          }
        ],
        getAllWorktreeMeta: () => ({}),
        getFolderWorkspaces: () => [{ folderPath: join(root, 'link-0') }]
      } as unknown as RuntimeStore

      const result = await sweepDeletedWorkspaceChatHistory({
        store,
        now: NOW,
        listSessions: async () => [session('gone.jsonl', join(workspaces, 'app', 'gone'))],
        isEnabled: () => true,
        deleteSessions: async (targets) => {
          deleted.push(...targets)
          return { deleted: targets.length, failed: 0, freedBytes: 0 }
        }
      })

      expect(deleted).toEqual([])
      expect(result).toEqual({ deleted: 0, failed: 0, freedBytes: 0 })
    }
  )
})
