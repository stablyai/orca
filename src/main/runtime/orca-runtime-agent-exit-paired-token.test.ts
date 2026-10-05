import { describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import { A, WT, makeAgentExitHost } from './agent-exit-host.test-fixture'
import { SetTabProps } from '../../shared/rpc-contract/session-tabs-schemas-params'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

describe('a paired client receives each pane token through the real projection (RD5-1)', () => {
  it("carries a desktop host renderer's token to listMobileSessionTabs", async () => {
    const runtime = new OrcaRuntimeService(store)
    // A desktop host: its renderer owns the tabs and mints the tokens.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths only test the window for presence.
    const window = {} as BrowserWindow
    runtime['getAvailableAuthoritativeWindow'] = () => window
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'tab-1::pane:1',
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: 'tab-1::pane:1',
          parentTabId: 'tab-1',
          leafId: 'pane:1',
          title: 'claude',
          viewMode: 'chat',
          presentationToken: 'epoch.3.abc',
          isActive: true
        }
      ]
    }
    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot] })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const row = listed.tabs.find((tab) => tab.type === 'terminal')
    expect(row?.type === 'terminal' ? row.presentationToken : undefined).toBe('epoch.3.abc')
  })

  it("publishes a headless host's token, and an exit request fenced by it applies", async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 2, chatLeafId: A })
    const row = (await host.published()).find((tab) => tab.leafId === A)
    expect(row?.presentationToken).toBeTruthy()
    const params = SetTabProps.parse({
      worktree: `id:${WT}`,
      tabId: row!.id,
      viewMode: 'terminal',
      agentExit: { presentationToken: row!.presentationToken }
    })
    const reply = await host.runtime.setMobileSessionTabProps(params.worktree, {
      tabId: params.tabId,
      viewMode: 'terminal',
      ...(params.agentExit ? { agentExit: params.agentExit } : {})
    })
    expect(reply.agentExitDisposition).toBe('applied')
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
  })

  it('retires a pane that owns chat when the client held no token, and leaves another owner alone', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 2, chatLeafId: A })
    const rows = await host.published()
    const other = rows.find((tab) => tab.leafId !== A)!
    const params = SetTabProps.parse({
      worktree: `id:${WT}`,
      tabId: other.id,
      viewMode: 'terminal',
      agentExit: {}
    })
    const untouched = await host.runtime.setMobileSessionTabProps(params.worktree, {
      tabId: params.tabId,
      viewMode: 'terminal',
      agentExit: params.agentExit!
    })
    expect(untouched.agentExitDisposition).toBe('unchanged')
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
    const own = rows.find((tab) => tab.leafId === A)!
    const reply = await host.runtime.setMobileSessionTabProps(`id:${WT}`, {
      tabId: own.id,
      viewMode: 'terminal',
      agentExit: {}
    })
    expect(reply.agentExitDisposition).toBe('applied')
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
  })
})
