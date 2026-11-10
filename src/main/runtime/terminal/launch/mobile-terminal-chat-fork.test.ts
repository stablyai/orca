import { expect, it, vi } from 'vitest'
import type { RuntimeNotifier } from '../../client/events/runtime-notifier-contract'
import './mobile-terminal-chat-fork'
import { prepareStructuredChatCliFork } from '../../../ai-vault/structured-chat-cli-fork'
import '../../orchestration/orchestration-error'
import '../../../../shared/project-runtime-repair-message'
import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { committingSpawn } from '../../orca-runtime-tests/bind-first-pane.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
vi.mock('../../../ai-vault/structured-chat-cli-fork', () => ({
  prepareStructuredChatCliFork: vi.fn(),
  isStructuredChatCliForkSourceCurrent: vi.fn(() => true)
}))
const cwd = process.platform === 'win32' ? 'C:\\repo' : '/tmp/repo'
const filePath = process.platform === 'win32' ? 'C:\\sessions\\chat.jsonl' : '/tmp/chat.jsonl'

it.each([true, false])(
  'forks a source-selected chat with saved placement available: %s',
  async (saved) => {
    await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
    const { OrcaRuntimeService } = await import('../../orca-runtime')
    const { electronMocks } = await import('../../orca-runtime-test-mocks/setup.spec')
    const {
      TEST_WORKTREE_ID: wt,
      makeRuntimeStoreWithWorkspaceSession,
      makeWorkspaceSessionWithHeadlessTerminal
    } = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
    const { withChatTabChanges } = await import('../../agent-session/agent-session-tab-layout')
    const source = 'source-chat',
      row = `agent-session:${source}`,
      canonical = 'custom-chat-tab'
    const initial = makeWorkspaceSessionWithHeadlessTerminal()
    const session =
      withChatTabChanges('local', initial, wt, [
        { open: { sessionId: source, agent: 'claude', tabId: canonical } }
      ]) ?? initial
    const group = session.tabGroups?.[wt]?.[0]
    if (!group) {
      throw new Error('Missing saved group')
    }
    group.tabOrder = [canonical, 'host-tab']
    const fixture = makeRuntimeStoreWithWorkspaceSession(saved ? session : initial)
    const admit = vi.spyOn(fixture.runtimeStore, 'admitTerminalPane')
    const service = new OrcaRuntimeService(fixture.runtimeStore)
    const spawn = vi.fn(
      async (_options: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
        id: 'pty-fork',
        incarnationId: '45454545-4545-4545-8545-454545454545'
      })
    )
    service.setPtyController({
      spawn: committingSpawn(service, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: vi.fn(),
        capturePage: async () => undefined
      }
    })
    service.attachWindow(1)
    service.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { createMobileCreateTestNotifier } =
      await import('../../orca-runtime-tests/orca-runtime-test-scenario-builders.spec')
    const reveal = vi.fn<NonNullable<RuntimeNotifier['revealTerminalSession']>>(
      (_worktree, opts) => {
        if (!opts.tabId || !opts.leafId) {
          throw new Error('Missing revealed pane')
        }
        return {
          tabId: opts.tabId,
          identity: {
            worktreeId: wt,
            tabId: opts.tabId,
            leafId: opts.leafId,
            ptyId: opts.ptyId
          }
        }
      }
    )
    service.setNotifier({
      ...createMobileCreateTestNotifier(vi.fn()),
      revealTerminalSession: reveal
    })
    vi.spyOn(service, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    await service.publishStructuredAgentSessionTab({
      workspaceId: wt,
      sessionId: source,
      agent: 'claude',
      activate: true
    })
    vi.mocked(prepareStructuredChatCliFork).mockResolvedValue({
      useRealCodexHome: false,
      cliForkSource: {
        agent: 'claude',
        sourceAgent: 'claude',
        sessionId: source,
        filePath,
        cwd,
        codexHome: null,
        executionHostPlatform: process.platform
      }
    })
    const created = await service.createMobileSessionTerminal(`id:${wt}`, {
      sourceChatFork: { sessionId: source },
      afterTabId: row,
      clientMutationId: 'fork',
      navigation: 'caller',
      clientNavigationId: 'phone',
      supportsSplitGroupPlacement: true
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(source)
      })
    )
    expect(admit).toHaveBeenCalledOnce()
    expect(admit.mock.calls[0]?.[0]).toMatchObject({
      type: 'createTerminalTab',
      tabId: created.tab.parentTabId,
      ...(saved ? { afterTabId: canonical, groupId: group.id } : {})
    })
    expect(admit.mock.calls[0]?.[0]).not.toMatchObject({ afterTabId: row })
    expect(reveal).toHaveBeenCalledWith(
      wt,
      expect.objectContaining({
        tabId: created.tab.parentTabId,
        leafId: created.tab.leafId,
        ptyId: created.tab.ptyId,
        activate: false,
        focus: false,
        presentation: 'background',
        surfaceOwner: false,
        ...(saved ? { afterTabId: canonical, targetGroupId: group.id } : {})
      })
    )
    if (saved) {
      expect(
        fixture.getSession().tabGroups?.[wt]?.find((entry) => entry.id === group.id)?.tabOrder
      ).toEqual([canonical, created.tab.parentTabId, 'host-tab'])
      expect(fixture.getSession().unifiedTabs?.[wt]).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: canonical, entityId: source })])
      )
    } else if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(admit.mock.calls[0]?.[0]).toMatchObject({
        afterTabId: structuredAgentSessionTabId(source)
      })
    } else {
      expect(admit.mock.calls[0]?.[0]).not.toHaveProperty('afterTabId')
      expect(reveal.mock.calls[0]?.[1]).not.toHaveProperty('afterTabId')
      expect(reveal.mock.calls[0]?.[1]).not.toHaveProperty('targetGroupId')
    }
    expect((await service.listMobileSessionTabs(`id:${wt}`)).tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agent-session', id: row, sessionId: source })
      ])
    )
  }
)
