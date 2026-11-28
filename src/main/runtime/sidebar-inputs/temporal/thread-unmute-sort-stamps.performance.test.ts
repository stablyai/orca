import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
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
import { sidebarFactsRuntime } from '../orca-runtime-sidebar-temporal'

// Exercise the main-owned sidebar build; the unit runner normally selects the window-owned build.
vi.mock('../../../../shared/sidebar-list/feed/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))

// #49861: a fresh mention must not enter the all-pane sort-stamp pass when it saves an unmute.
it.each([100, 1_000])(
  'skips sort-stamp reconciliation on thread unmute with %i panes',
  async (population) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-thread-unmute-perf-'))
    testState.dir = dir
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = createStore()
    const project = store.createProjectGroup({
      name: 'Bots',
      parentPath: dir,
      connectionId: null,
      parentGroupId: null,
      createdFrom: 'manual'
    })
    const folder = store.createFolderWorkspace({ projectGroupId: project.id, folderPath: dir })
    const workspace = { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }
    const thread = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' } as const
    writeLink(store, workspace, {
      ...thread,
      sessionId: 'bot-chat',
      agent: 'claude',
      paneKey: 'own-working',
      bot: { kind: 'bot', botId: 'bot1' },
      muted: true,
      createdAt: Date.now()
    })
    store.updateFolderWorkspace(folder.id, { isUnread: true })
    const hookStatus = (
      paneKey: string,
      worktreeId: string,
      state: AgentStatusIpcPayload['state']
    ): AgentStatusIpcPayload => ({
      paneKey,
      worktreeId,
      state,
      prompt: '',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    })
    const rows = [
      hookStatus('own-working', workspace.worktreeId, 'working'),
      hookStatus('own-done', workspace.worktreeId, 'done'),
      ...Array.from({ length: population - 2 }, (_, i) =>
        hookStatus(`unrelated-${i}`, folderWorkspaceKey(`unrelated-${i}`), 'working')
      )
    ]
    const byPane = new Map(rows.map((row) => [row.paneKey, row]))
    const runtime = new OrcaRuntimeService(store)
    const sidebar = sidebarFactsRuntime(runtime)
    if (!sidebar) {
      throw new Error('the main-owned sidebar is unavailable')
    }
    const detach = sidebar.attachAgentStatusStore({
      getStatusSnapshot: () => rows,
      getStatusSnapshotForPane: (key) => {
        const row = byPane.get(key)
        return row ? [row] : []
      },
      subscribeStatusRowMutations: () => () => {},
      subscribeStatusFreshness: () => () => {}
    })
    const fullReconciliations = vi.spyOn(sidebar.sortStamps, 'noteRecordsWritten')
    try {
      expect(store.getFolderWorkspace(folder.id)?.smartTier).toBe('done')
      const wake = handleThreadMute(
        {
          read: (key) => readThreadMute(store, key),
          write: threadMuteSaves(store),
          queued: async (_key, work) => {
            await work?.()
            return undefined
          },
          waiting: new Map()
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
      expect(fullReconciliations).not.toHaveBeenCalled()

      store.updateFolderWorkspace(folder.id, { isUnread: false })
      expect(fullReconciliations).toHaveBeenCalled()
      expect(store.getFolderWorkspace(folder.id)?.smartTier).toBe('working')
    } finally {
      fullReconciliations.mockRestore()
      detach()
      vi.useRealTimers()
      await closeTestStores()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
