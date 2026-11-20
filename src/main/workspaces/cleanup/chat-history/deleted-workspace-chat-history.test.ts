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
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import {
  sweepDeletedWorkspaceChatHistory,
  type ChatHistorySweepDeps,
  type ChatHistoryTarget
} from './deleted-workspace-chat-history'
import {
  folderIdentityOf,
  readDeletedWorkspaceFolderRecords,
  readWorkspaceFolderBeforeDeletion,
  recordDeletedWorkspaceFolder
} from './deleted-workspace-folder-records'

const NOW = Date.parse('2026-11-16T12:00:00.000Z')
const DAY_AGO = '2026-11-15T12:00:00.000Z'
const TEN_MINUTES_AGO = '2026-11-16T11:50:00.000Z'
const TWO_DAYS_AGO = '2026-11-14T12:00:00.000Z'
const CREATED_AT = Date.parse('2026-11-01T12:00:00.000Z')
// Just after the day-old transcripts were last written.
const DELETED_AT = Date.parse('2026-11-15T13:00:00.000Z')

let root = ''

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<{ homedir: () => string }>()
  return { ...os, homedir: () => home.path || os.homedir() }
})

afterEach(() => {
  home.path = ''
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

const profileDirectory = (): string => join(root, 'profile')

/** What Orca writes when it deletes a workspace folder: the folder must already be gone. */
async function recordDeleted(
  path: string,
  { createdAt = CREATED_AT, deletedAt = DELETED_AT } = {}
): Promise<void> {
  const parentId = await folderIdentityOf(dirname(path))
  if (parentId) {
    mkdirSync(profileDirectory(), { recursive: true })
    await recordDeletedWorkspaceFolder(
      profileDirectory(),
      { path, parentId, name: basename(path), createdAt },
      deletedAt
    )
  }
}

/** A day-old transcript started two days ago; `lastCwd` is where it was last resumed. */
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
    createdAt: TWO_DAYS_AGO,
    modifiedAt: DAY_AGO,
    ...overrides
  } as AiVaultSession
}

/** An Orca chat at rest since yesterday in the git worktree at `path`. */
function nativeChat(
  sessionId: string,
  path: string,
  overrides: Partial<Omit<AgentSessionRecord, 'location'>> = {},
  location: Partial<AgentSessionRecord['location']> = {}
): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    createdAt: Date.parse(DAY_AGO),
    ...overrides,
    location: { workspaceId: `app::${path}`, workspaceKind: 'git-worktree', ...location }
  })
}

/** Repo `app` with nested workspaces under `<root>/workspaces`. */
function appStore(
  folderWorkspaces: { folderPath: string }[] = [],
  workspaceDir = join(root, 'workspaces')
): RuntimeStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these store methods
  return {
    getProfileStorageDirectory: profileDirectory,
    getSettings: () => ({ workspaceDir, nestWorkspaces: true, workspaceDirHistory: [] }),
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
    getFolderWorkspaces: () => folderWorkspaces
  } as unknown as RuntimeStore
}

/** Deletes each transcript the sweep still wants, as the real delete does. */
function recordingDelete(deleted: ChatHistoryTarget[]): ChatHistorySweepDeps['deleteSessions'] {
  return async (targets, shouldDelete) => {
    let count = 0
    for (const target of targets) {
      if (await shouldDelete(target)) {
        rmSync(target.filePath, { force: true })
        deleted.push(target)
        count += 1
      }
    }
    return { deleted: count, failed: 0, freedBytes: 0 }
  }
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
        getProfileStorageDirectory: profileDirectory,
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
      // Orca deleted every gone folder here; the other checks still keep what isn't the workspace's.
      for (const path of [
        ...[
          'gone',
          'gone-two',
          'gone-three',
          'gone-five',
          'gone-six',
          'gone-seven',
          'linked-gone',
          'archived',
          'archived-mid-scan',
          'old-name',
          'team',
          'folder-workspace',
          'spaced'
        ].map((name) => join(appWorkspaces, name)),
        join(workspaces, 'api', 'old-package'),
        join(workspaces, 'tools', 'old'),
        join(workspaces, 'docs', 'packages'),
        join(root, 'repos', 'sibling', 'old-tool'),
        join(root, 'repos', 'sibling', 'website')
      ]) {
        await recordDeleted(path)
      }

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

      const live = nativeChat('live-lease', gone).lease
      const nativeChats = [
        nativeChat('native-gone', gone),
        nativeChat('native-live', join(appWorkspaces, 'live')),
        nativeChat('native-archived', join(appWorkspaces, 'archived')),
        nativeChat('native-renamed', join(appWorkspaces, 'old-name')),
        // Archived while transcripts of its folder were being deleted.
        nativeChat('native-archived-between', join(appWorkspaces, 'gone-six')),
        nativeChat('native-recent', gone, {
          lastTurn: { state: 'settled', at: Date.parse(TEN_MINUTES_AGO) }
        }),
        nativeChat('native-owned', gone, { lease: { ...live, claimStatus: 'reserved' } }),
        nativeChat('native-folder', gone, {}, { workspaceKind: 'folder' }),
        nativeChat('native-wsl', gone, {}, { wslDistro: 'Ubuntu' }),
        nativeChat('native-server', gone, {}, { executionHostId: 'runtime:env-1' }),
        nativeChat('native-unmounted', join(root, 'unmounted', 'other', 'feature'))
      ]
      const forgotten: string[] = []

      const result = await sweepDeletedWorkspaceChatHistory({
        store,
        now: NOW,
        listNativeChats: () => nativeChats,
        forgetNativeChats: async (chats, shouldForget) => {
          for (const chat of chats) {
            if (await shouldForget(chat)) {
              forgotten.push(chat.sessionId)
            }
          }
          return { deleted: forgotten.length, failed: 0, freedBytes: 0 }
        },
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
      expect(forgotten).toEqual(['native-gone'])
      expect(result).toEqual({ deleted: 6, failed: 0, freedBytes: 105 })
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
      await recordDeleted(join(workspaces, 'app', 'gone'))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these store methods
      const store = {
        getProfileStorageDirectory: profileDirectory,
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

  it('under a listed home folder, deletes only the history of a workspace Orca recorded deleting, never a folder the user made beside it', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
    home.path = root
    const appWorkspaces = join(root, 'workspaces', 'app')
    mkdirSync(appWorkspaces, { recursive: true })
    mkdirSync(join(root, 'repos', 'app'), { recursive: true })
    await recordDeleted(join(appWorkspaces, 'feature'))
    const deleted: ChatHistoryTarget[] = []
    const forgotten: string[] = []

    await sweepDeletedWorkspaceChatHistory({
      store: appStore([{ folderPath: root }]),
      now: NOW,
      listSessions: async () => [
        session('feature.jsonl', join(appWorkspaces, 'feature')),
        // A folder the user made next to the workspace and later removed: Orca never deleted it.
        session('scratch.jsonl', join(appWorkspaces, 'scratch'))
      ],
      listNativeChats: () => [
        nativeChat('native-feature', join(appWorkspaces, 'feature')),
        nativeChat('native-scratch', join(appWorkspaces, 'scratch'))
      ],
      forgetNativeChats: async (chats, shouldForget) => {
        for (const chat of chats) {
          if (await shouldForget(chat)) {
            forgotten.push(chat.sessionId)
          }
        }
        return { deleted: forgotten.length, failed: 0, freedBytes: 0 }
      },
      isEnabled: () => true,
      deleteSessions: recordingDelete(deleted)
    })

    expect(deleted.map((target) => basename(target.filePath))).toEqual(['feature.jsonl'])
    expect(forgotten).toEqual(['native-feature'])
  })

  // Creating symlinks needs a privilege ordinary Windows CI lacks.
  it.skipIf(process.platform === 'win32')(
    'matches a recorded folder through a symlinked workspace folder and a trailing slash, but only by its exact name',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
      mkdirSync(join(root, 'real', 'app', 'feature'), { recursive: true })
      mkdirSync(join(root, 'repos', 'app'), { recursive: true })
      symlinkSync(join(root, 'real'), join(root, 'workspaces'))
      const linked = join(root, 'workspaces', 'app', 'feature')
      // What a removal reads first, as Orca spells the path.
      const folder = await readWorkspaceFolderBeforeDeletion(`${linked}/`)
      mkdirSync(profileDirectory(), { recursive: true })
      // A delete that left the folder behind records nothing.
      await recordDeletedWorkspaceFolder(profileDirectory(), folder!, DELETED_AT)
      expect(await readDeletedWorkspaceFolderRecords(profileDirectory())).toEqual([])
      rmSync(join(root, 'real', 'app', 'feature'), { recursive: true })
      await recordDeletedWorkspaceFolder(
        profileDirectory(),
        { ...folder!, createdAt: CREATED_AT },
        DELETED_AT
      )
      const deleted: ChatHistoryTarget[] = []

      await sweepDeletedWorkspaceChatHistory({
        store: appStore(),
        now: NOW,
        listSessions: async () => [
          // Agents record the physical folder.
          session('physical.jsonl', join(realpathSync(root), 'real', 'app', 'feature', 'web')),
          // Another spelling is another folder on a case-sensitive disk: never proven Orca's.
          session('other-case.jsonl', join(root, 'real', 'app', 'Feature'))
        ],
        isEnabled: () => true,
        deleteSessions: recordingDelete(deleted)
      })

      expect(deleted.map((target) => basename(target.filePath))).toEqual(['physical.jsonl'])
    }
  )

  it('keeps chats begun or active after Orca deleted the folder, and forgets a folder that came back', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
    const appWorkspaces = join(root, 'workspaces', 'app')
    mkdirSync(appWorkspaces, { recursive: true })
    mkdirSync(join(root, 'repos', 'app'), { recursive: true })
    const feature = join(appWorkspaces, 'feature')
    await recordDeleted(feature)
    const deleted: ChatHistoryTarget[] = []
    const sweep = (sessions: AiVaultSession[]) =>
      sweepDeletedWorkspaceChatHistory({
        store: appStore(),
        now: NOW,
        listSessions: async () => sessions,
        isEnabled: () => true,
        deleteSessions: recordingDelete(deleted)
      })

    // The user re-created the folder and removed it again before any sweep saw it.
    const writtenLater = session('written-later.jsonl', feature)
    const laterWrite = new Date(DELETED_AT + 60 * 60 * 1000)
    utimesSync(writtenLater.filePath, laterWrite, laterWrite)
    await sweep([
      session('workspace.jsonl', feature),
      session('started-later.jsonl', feature, { createdAt: '2026-11-15T14:00:00.000Z' }),
      session('started-before.jsonl', feature, { createdAt: '2026-10-01T12:00:00.000Z' }),
      session('no-start.jsonl', feature, { createdAt: null }),
      writtenLater
    ])
    expect(deleted.map((target) => basename(target.filePath))).toEqual(['workspace.jsonl'])

    // Seen back on disk, the record no longer proves anything, even once the folder is gone again.
    mkdirSync(feature)
    await sweep([session('back.jsonl', feature)])
    rmSync(feature, { recursive: true })
    await sweep([session('gone-again.jsonl', feature)])
    expect(deleted.map((target) => basename(target.filePath))).toEqual(['workspace.jsonl'])
    expect(await readDeletedWorkspaceFolderRecords(profileDirectory())).toEqual([])
  })

  it.each([
    ['an older format', { version: 0, folders: [{ path: 'FEATURE', deletedAt: 1 }] }],
    ['a newer format', { version: 2, folders: [{ path: 'FEATURE', deletedAt: 1 }] }],
    [
      'entries missing fields',
      { version: 1, folders: [{ path: 'FEATURE', name: 'feature', deletedAt: DELETED_AT }] }
    ],
    ['a damaged file', null]
  ])('deletes nothing from records in %s', async (_name, contents) => {
    root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
    const appWorkspaces = join(root, 'workspaces', 'app')
    mkdirSync(appWorkspaces, { recursive: true })
    mkdirSync(join(root, 'repos', 'app'), { recursive: true })
    const feature = join(appWorkspaces, 'feature')
    mkdirSync(profileDirectory(), { recursive: true })
    writeFileSync(
      join(profileDirectory(), 'orca-deleted-workspace-folders.json'),
      contents === null
        ? '{"version":1,"fol'
        : JSON.stringify(contents).replaceAll('FEATURE', feature)
    )
    const deleted: ChatHistoryTarget[] = []

    await sweepDeletedWorkspaceChatHistory({
      store: appStore(),
      now: NOW,
      listSessions: async () => [session('feature.jsonl', feature)],
      isEnabled: () => true,
      deleteSessions: recordingDelete(deleted)
    })

    expect(deleted).toEqual([])
  })

  it("after a restart, two sweeps at once delete a recorded workspace's chat once", async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-chat-history-'))
    const appWorkspaces = join(root, 'workspaces', 'app')
    mkdirSync(appWorkspaces, { recursive: true })
    mkdirSync(join(root, 'repos', 'app'), { recursive: true })
    await recordDeleted(join(appWorkspaces, 'feature'))
    const sessions = [session('feature.jsonl', join(appWorkspaces, 'feature'))]
    // A new process reads the records from disk alone.
    vi.resetModules()
    const restarted = await import('./deleted-workspace-chat-history')
    const deleted: ChatHistoryTarget[] = []
    const sweep = () =>
      restarted.sweepDeletedWorkspaceChatHistory({
        store: appStore(),
        now: NOW,
        listSessions: async () => sessions,
        isEnabled: () => true,
        deleteSessions: recordingDelete(deleted)
      })

    const results = await Promise.all([sweep(), sweep()])

    expect(deleted.map((target) => basename(target.filePath))).toEqual(['feature.jsonl'])
    expect(results.reduce((total, result) => total + result.deleted, 0)).toBe(1)
  })
})
