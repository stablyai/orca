import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SIDEBAR_INPUTS_PAGE_MAX_BYTES } from '../../../../shared/sidebar-list/feed/sidebar-inputs-feed-contract'
import * as workspaceRows from '../../../../shared/sidebar-list/feed-facts/workspace-rows'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { handleThreadMute } from '../../../connector-cloud/connector-thread-mute'
import { threadMuteSaves } from '../../../connector-cloud/connector-thread-mute-saves'
import { readThreadMute } from '../../../external-conversations/external-conversation-link-writes'
import { writeLink } from '../../../external-conversations/external-conversation-links'
import {
  closeTestStores,
  createStore,
  testState
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import * as scans from '../../workspaces/catalog/resolved-worktree-scan-join'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'

vi.mock('../../../../shared/sidebar-list/feed/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))

// #49861: persisting a Slack thread unmute must not rebuild or encode unrelated sidebar rows.
it.each([
  [750, 100],
  [7_500, 1_000]
])(
  'does no fleet row work on unmute among %i git worktrees and %i folders',
  async (gitCount, folderCount) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-thread-unmute-rows-'))
    testState.dir = dir
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = createStore()
    const project = store.createProjectGroup({
      name: 'Seeded project',
      parentPath: dir,
      connectionId: null,
      parentGroupId: null,
      createdFrom: 'manual'
    })
    const folders = Array.from({ length: folderCount }, (_, i) =>
      store.createFolderWorkspace({
        projectGroupId: project.id,
        folderPath: join(dir, `folder-${i}`)
      })
    )
    const folder = folders[0]!
    const id = folderWorkspaceKey(folder.id)
    const thread = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' } as const
    writeLink(
      store,
      { worktreeId: id, sshHostId: null },
      {
        ...thread,
        sessionId: 'bot-chat',
        agent: 'claude',
        paneKey: 'bot-pane',
        bot: { kind: 'bot', botId: 'bot1' },
        muted: true,
        createdAt: Date.now()
      }
    )
    const worktrees = Array.from({ length: gitCount }, (_, i): ResolvedWorktree => {
      const path = join(dir, `checkout-${i}`)
      const git = {
        path,
        head: 'a'.repeat(40),
        branch: `refs/heads/change-${i}`,
        isBare: false,
        isMainWorktree: false
      }
      return {
        ...git,
        id: `repo::${path}`,
        repoId: 'repo',
        hostId: 'local',
        displayName: `Checkout ${i}`,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        git
      }
    })
    const gitRows = vi.spyOn(scans, 'joinResolvedWorktreeScans').mockReturnValue({
      worktrees,
      platformByRepoId: new Map(),
      unscannedRepoKeys: new Set(),
      gitRunById: new Map(),
      scannedRepoKeys: new Set()
    })
    const runtime = new OrcaRuntimeService(store)
    const feed = runtime.sidebarInputsFeed
    const producer = runtime.workspaceRows
    if (!feed || !producer) {
      throw new Error('the main-owned sidebar is unavailable')
    }
    const buildRows = vi.spyOn(workspaceRows, 'buildWorkspaceRows')
    const json = JSON.stringify
    let encodedRows = 0
    const stringify = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, replacer, space) => {
        if (
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          (value.kind === 'git' || value.kind === 'folder') &&
          'lineage' in value &&
          'displayName' in value
        ) {
          encodedRows++
        }
        return json(value, replacer, space)
      })
    let subscriber = 'first'
    try {
      feed.acquire(subscriber)
      const snapshot = await feed.read({ maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES })
      expect(Object.keys(producer.snapshot()?.rows ?? {})).toHaveLength(gitCount + folderCount)
      expect(encodedRows).toBe(gitCount + folderCount)
      buildRows.mockClear()
      encodedRows = 0

      const wake = handleThreadMute(
        {
          read: (key) => readThreadMute(store, key),
          write: threadMuteSaves(store),
          waiting: new Map(),
          queued: async (_key, work) => {
            await work?.()
            return undefined
          }
        },
        {
          conversation: thread,
          kind: 'start',
          deliveryId: 'mention-1',
          expiresAt: Date.now() + 30_000,
          agent: 'claude',
          placeId: 'bot-home',
          prompt: 'come back',
          mentioned: true
        },
        async (handled) => await handled()
      )
      await expect(wake?.decided).resolves.toBe('send')
      expect(readThreadMute(store, thread)).toEqual({ botId: 'bot1', muted: false })
      const after = await feed.read({
        generation: snapshot.generation,
        cursor: snapshot.revision,
        maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES
      })
      expect({ builds: buildRows.mock.calls.length, encodedRows }).toEqual({
        builds: 0,
        encodedRows: 0
      })

      const links = store.getFolderWorkspace(folder.id)?.externalConversations
      store.updateFolderWorkspace(folder.id, { externalConversations: links, isUnread: true })
      const changed = await feed.read({
        generation: after.generation,
        cursor: after.revision,
        maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES
      })
      expect(Object.values(changed.domains.workspaces?.upserts ?? {})).toContainEqual(
        expect.objectContaining({ id, isUnread: true })
      )
      feed.release(subscriber)
      buildRows.mockClear()
      encodedRows = 0
      store.updateFolderWorkspace(folder.id, { isUnread: false })
      await Promise.resolve()
      expect({ builds: buildRows.mock.calls.length, encodedRows }).toEqual({
        builds: 0,
        encodedRows: 0
      })
      subscriber = 'reconnected'
      feed.acquire(subscriber)
      await feed.read({ maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES })
      expect(Object.values(producer.snapshot()?.rows ?? {})).toContainEqual(
        expect.objectContaining({ id, isUnread: false })
      )
    } finally {
      feed.release(subscriber)
      stringify.mockRestore()
      buildRows.mockRestore()
      gitRows.mockRestore()
      vi.useRealTimers()
      await closeTestStores()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
