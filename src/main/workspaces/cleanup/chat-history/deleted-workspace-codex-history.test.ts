import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import { deleteCodexRolloutsPermanently } from '../../../codex/history/cleanup/codex-rollout-permanent-delete'
import { sweepDeletedWorkspaceChatHistory } from './deleted-workspace-chat-history'

// Fixed and long past: the sweep's own idle check reads the clock, and these files are older than any run.
const WRITTEN = new Date('2026-01-01T12:00:00.000Z')
const NOW = Date.parse('2026-01-02T12:00:00.000Z')
const NAME = (id: string): string =>
  `rollout-2026-11-01T10-00-00-0000000${id}-0000-4000-8000-000000000000.jsonl`
const DATED = ['sessions', '2026', '11', '01']

let root: string

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** A Codex rollout: the start folder, one turn per later cwd, then a long reply with no cwd. */
function rollout(startCwd: string, turnCwds: string[] = []): string {
  const records = [
    { type: 'session_meta', payload: { id: 'thread', cwd: startCwd } },
    ...turnCwds.map((cwd) => ({ type: 'turn_context', payload: { cwd } })),
    // Tool calls name other folders; only session_meta and turn_context records count.
    { type: 'event_msg', payload: { type: 'exec', cwd: startCwd, text: 'x'.repeat(300 * 1024) } }
  ]
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function write(path: string, contents: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  utimesSync(path, WRITTEN, WRITTEN)
  return path
}

describe('sweepDeletedWorkspaceChatHistory with Codex rollouts', () => {
  // Creating symlinks on Windows needs Developer Mode or admin rights.
  it.skipIf(process.platform === 'win32')(
    'deletes every name a rollout has across Codex homes unless any copy ran elsewhere',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'orca-codex-history-'))
      vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
      const appWorkspaces = join(root, 'workspaces', 'app')
      mkdirSync(join(appWorkspaces, 'live'), { recursive: true })
      mkdirSync(join(root, 'repos', 'app'), { recursive: true })
      const gone = join(appWorkspaces, 'gone')
      const live = join(appWorkspaces, 'live')
      const system = join(root, 'codex')
      const managed = join(root, 'user-data', 'codex-runtime-home', 'home')
      const account = join(root, 'user-data', 'codex-accounts', 'a1', 'home')
      const homes = [system, managed, account]

      // Shared across homes by hardlink, archived under the account, and a stale link in the mirror.
      const shared = write(join(system, ...DATED, NAME('1')), rollout(gone, [gone]))
      mkdirSync(join(managed, ...DATED), { recursive: true })
      linkSync(shared, join(managed, ...DATED, NAME('1')))
      const sharedPacked = write(
        join(account, ...DATED, `${NAME('1')}.zst`),
        zstdCompressSync(rollout(gone, [gone]))
      )
      const sharedArchived = write(join(account, 'archived_sessions', NAME('1')), rollout(gone))
      symlinkSync(join(root, 'missing'), join(managed, ...DATED, `${NAME('1')}.zst`))
      const marker = write(
        join(managed, '.orca-session-copies', '2026', '11', '01', `${NAME('1')}.json`),
        '{}'
      )

      // Codex compressed the account's copy, breaking the link, and that copy was resumed in `live`.
      const resumed = write(join(system, ...DATED, NAME('2')), rollout(gone, [gone]))
      const resumedPacked = write(
        join(account, ...DATED, `${NAME('2')}.zst`),
        zstdCompressSync(rollout(gone, [gone, live]))
      )

      // Archived by Codex before it ever ran a turn, and hardlinked into a backup Orca doesn't know.
      const packedOnly = write(
        join(system, ...DATED, `${NAME('3')}.zst`),
        zstdCompressSync(rollout(gone))
      )
      mkdirSync(join(root, 'backup'))
      linkSync(packedOnly, join(root, 'backup', 'rollout.zst'))
      // A cross-volume bridge's symlink to it: removing the target first must not read as a change.
      const packedLink = join(account, ...DATED, `${NAME('3')}.zst`)
      symlinkSync(packedOnly, packedLink)

      // A reverted thread's rollout, named by thread id and rollout id.
      const reverted = write(
        join(
          system,
          ...DATED,
          NAME('6').replace('.jsonl', '_00000006-0000-4000-8000-000000000001.jsonl')
        ),
        rollout(gone, [gone])
      )

      // Resumed under an account and still open there, with no turn written yet.
      const open = write(join(system, ...DATED, NAME('4')), rollout(gone, [gone]))
      write(join(account, 'thread-writer-locks', '00000004-0000-4000-8000-000000000000.lock'), '')

      // Space returns only for files whose every link went; the backup keeps the last one's.
      const freed =
        statSync(shared).size +
        statSync(sharedPacked).size +
        statSync(sharedArchived).size +
        statSync(reverted).size
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these store methods
      const store = {
        getSettings: () => ({
          workspaceDir: join(root, 'workspaces'),
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
        getFolderWorkspaces: () => []
      } as unknown as RuntimeStore
      // AI Vault lists one name per rollout.
      const listed = [shared, resumed, packedOnly, reverted, open].map(
        (filePath) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only the fields set here
          ({
            executionHostId: 'local',
            agent: 'codex',
            sessionId: filePath,
            cwd: gone,
            filePath,
            modifiedAt: WRITTEN.toISOString()
          }) as AiVaultSession
      )

      const result = await sweepDeletedWorkspaceChatHistory({
        store,
        now: NOW,
        listSessions: async () => listed,
        isEnabled: () => true,
        deleteSessions: (targets, shouldDelete) =>
          deleteCodexRolloutsPermanently(targets, shouldDelete, async () => ({
            homes,
            protectedRoots: []
          }))
      })

      expect(
        [
          shared,
          join(managed, ...DATED, NAME('1')),
          sharedPacked,
          sharedArchived,
          join(managed, ...DATED, `${NAME('1')}.zst`),
          marker,
          packedOnly,
          packedLink,
          reverted
        ].filter(exists)
      ).toEqual([])
      expect([resumed, resumedPacked, open].filter(exists)).toEqual([resumed, resumedPacked, open])
      expect(result).toEqual({ deleted: 3, failed: 0, freedBytes: freed })

      // A Codex that keeps no writer locks gives no proof a chat isn't open, so its chats stay.
      rmSync(join(account, 'thread-writer-locks'), { recursive: true })
      const lockless = write(join(system, ...DATED, NAME('5')), rollout(gone, [gone]))
      const locklessRun = await sweepDeletedWorkspaceChatHistory({
        store,
        now: NOW,
        listSessions: async () => [{ ...listed[0], filePath: lockless }],
        isEnabled: () => true,
        deleteSessions: (targets, shouldDelete) =>
          deleteCodexRolloutsPermanently(targets, shouldDelete, async () => ({
            homes,
            protectedRoots: []
          }))
      })
      expect(exists(lockless)).toBe(true)
      expect(locklessRun).toEqual({ deleted: 0, failed: 0, freedBytes: 0 })
    }
  )
})

describe('deleteCodexRolloutsPermanently with forked chats', () => {
  it('keeps a rollout while a surviving fork reads its history, and deletes it after its forks', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-history-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    const home = join(root, 'codex')
    mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
    const fork = (cwd: string, parentId: string): string =>
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'fork',
          cwd,
          history_mode: 'paginated',
          history_base: { thread_id: parentId, end_ordinal_exclusive: 1, end_byte_offset: 10 }
        }
      })}\n`
    // A fork continued in a live folder reads its earlier turns from the gone folder's parent;
    // Codex skips a header line it can't parse, and reads one with no newline after it.
    const keptParent = write(join(home, ...DATED, NAME('7')), rollout('/gone'))
    const liveFork = write(
      join(home, ...DATED, NAME('8')),
      `{"type":"session_meta","payload":null}\n${fork('/live', '00000007-0000-4000-8000-000000000000').trimEnd()}`
    )
    // Both ran only in the gone folder; the parent is listed first.
    const goneParent = write(join(home, ...DATED, NAME('9')), rollout('/gone'))
    const goneFork = write(
      join(home, ...DATED, NAME('a')),
      fork('/gone', '00000009-0000-4000-8000-000000000000')
    )

    const result = await deleteCodexRolloutsPermanently(
      [keptParent, goneParent, goneFork].map((filePath) => ({ agent: 'codex', filePath })),
      async () => true,
      async () => ({ homes: [home], protectedRoots: [] })
    )

    expect([keptParent, liveFork, goneParent, goneFork].filter(exists)).toEqual([
      keptParent,
      liveFork
    ])
    expect(result.deleted).toBe(2)
    expect(result.failed).toBe(0)

    // Codex creates a fork's file empty and writes its header seconds later.
    const nextParent = write(join(home, ...DATED, NAME('b')), rollout('/gone'))
    const forkPath = join(home, ...DATED, NAME('c'))
    writeFileSync(forkPath, '')
    const sweep = () =>
      deleteCodexRolloutsPermanently(
        [{ agent: 'codex', filePath: nextParent }],
        async () => true,
        async () => ({ homes: [home], protectedRoots: [] })
      )
    await sweep()
    writeFileSync(forkPath, fork('/live', '0000000b-0000-4000-8000-000000000000'))
    utimesSync(forkPath, WRITTEN, WRITTEN)
    await sweep()

    expect(exists(nextParent)).toBe(true)
  })
})

describe('deleteCodexRolloutsPermanently with a fork archived during the sweep', () => {
  it('keeps the parent of a fork created and archived between two deletions', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-history-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    const home = join(root, 'codex')
    mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
    mkdirSync(join(home, 'archived_sessions'), { recursive: true })
    // A fixed local day: the sweep re-lists only the dated folders around today.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 20, 12))
    const now = new Date(2026, 10, 20, 12)
    const today = join(
      home,
      'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    )
    mkdirSync(today, { recursive: true })
    // Settled long ago, so a later listing of it isn't repeated unless it changes.
    utimesSync(today, WRITTEN, WRITTEN)
    utimesSync(join(home, 'archived_sessions'), WRITTEN, WRITTEN)
    const first = write(join(home, ...DATED, NAME('d')), rollout('/gone'))
    const parent = write(join(home, ...DATED, NAME('e')), rollout('/gone'))
    const fork = `${JSON.stringify({
      type: 'session_meta',
      payload: { history_base: { thread_id: '0000000e-0000-4000-8000-000000000000' } }
    })}\n`

    await deleteCodexRolloutsPermanently(
      [first, parent].map((filePath) => ({ agent: 'codex', filePath })),
      async ({ filePath }) => {
        if (filePath === parent) {
          // Codex forks the parent into today's folder, then the user archives the fork.
          const forked = write(join(today, NAME('f')), fork)
          renameSync(forked, join(home, 'archived_sessions', NAME('f')))
        }
        return true
      },
      async () => ({ homes: [home], protectedRoots: [] })
    )

    vi.useRealTimers()
    expect([first, parent].filter(exists)).toEqual([parent])
  })
})

describe('deleteCodexRolloutsPermanently with a fork restored during the sweep', () => {
  // Restored as it was, with its old timestamp; Windows has no unreadable mode to set.
  const modes = process.platform === 'win32' ? [0o644] : [0o644, 0o000]
  const restores = [
    ...modes.map((mode) => ({ mode, packed: false })),
    { mode: 0o644, packed: true }
  ]
  it.each(restores)(
    'keeps the parent when its deleted fork comes back (%o)',
    async ({ mode, packed }) => {
      root = mkdtempSync(join(tmpdir(), 'orca-codex-history-'))
      vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
      const home = join(root, 'codex')
      mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 10, 20, 12))
      // An old dated folder: a refresh re-lists only today's, so the restored name itself is checked.
      const folder = join(home, ...DATED)
      const parent = write(join(folder, NAME('1')), rollout('/gone'))
      const forkContents = `${JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/gone',
          history_base: { thread_id: '00000001-0000-4000-8000-000000000000' }
        }
      })}\n`
      const fork = write(join(folder, NAME('2')), forkContents)
      let restoredAt: string | null = null

      await deleteCodexRolloutsPermanently(
        [parent, fork].map((filePath) => ({ agent: 'codex', filePath })),
        async ({ filePath }) => {
          if (filePath === parent && !exists(fork) && !exists(`${fork}.zst`)) {
            // A backup restores the fork after it was deleted, before the parent is retried.
            restoredAt = packed ? `${fork}.zst` : fork
            const restored = packed
              ? write(`${fork}.zst`, zstdCompressSync(forkContents))
              : write(fork, forkContents)
            chmodSync(restored, mode)
          }
          return true
        },
        async () => ({ homes: [home], protectedRoots: [] })
      )

      vi.useRealTimers()
      expect(restoredAt).not.toBeNull()
      expect(exists(restoredAt!)).toBe(true)
      expect(exists(parent)).toBe(true)
    }
  )
})

describe('deleteCodexRolloutsPermanently across many Codex homes', () => {
  it('deletes an unreferenced rollout when more homes have archives than one sweep re-lists', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-history-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    const homes = Array.from({ length: 30 }, (_, index) => join(root, `home-${index}`))
    for (const home of homes) {
      mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
      mkdirSync(join(home, 'archived_sessions'), { recursive: true })
      utimesSync(join(home, 'archived_sessions'), WRITTEN, WRITTEN)
    }
    const target = write(join(homes[0], ...DATED, NAME('1')), rollout('/gone'))

    const result = await deleteCodexRolloutsPermanently(
      [{ agent: 'codex', filePath: target }],
      async () => true,
      async () => ({ homes, protectedRoots: [] })
    )

    expect(exists(target)).toBe(false)
    expect(result.deleted).toBe(1)
  })
})

/** Dangling links count: they block the name for later links. */
function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
